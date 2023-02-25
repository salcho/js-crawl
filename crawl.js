const puppeteer = require('puppeteer');
const modify = require('puppeteer-intercept-and-modify-requests');
const RequestInterceptionManager = modify.RequestInterceptionManager;

const parse = require('esprima').parse;
const generate = require('escodegen').generate;
const replace = require('ast-replace');
const typeBuilders = require('ast-types').builders;

function replaceBody(body) {
	const ast = replace(parse(body), {
		MemberExpression: {
			test: node => node.computed,
			replace: replaceMemberExpression
		}
	});
	return generate(ast);
}

// esprima only matches the top level MemberExpression, even when they're nested
// for example obj[a][b], so this function must be recursive
function replaceMemberExpression(node) {
	// deal with `obj[a]` when `obj[a][b]`
	if (node.object.type === 'MemberExpression') {
        node.object = replaceMemberExpression(node.object);
    }

	switch (node.property.type) {
		// deal with `obj[a]` when `obj[obj[a]]`
		case 'MemberExpression':
			node.property = replaceMemberExpression(node.property);
			break;
		// deal with `obj[b]` when `obj[a + obj[b]]`, on either side of the plus
		case 'BinaryExpression':
			node.property = replaceMemberExpressionForBinary(node.property);
			break;
		default:
			// fall through
	}

    const call = typeBuilders.callExpression(typeBuilders.identifier('foo'), [node.property]);
    node.property = call; 
    return node;
}

function replaceMemberExpressionForBinary(binary) {
	if (binary.left.type === 'MemberExpression') {
		binary.left = replaceMemberExpression(binary.left);
	}

	if (binary.right.type === 'MemberExpression') {
		binary.right = replaceMemberExpression(binary.right);
	}

	return binary;
}

async function browseModifyAndCaptureSelector(url) {
	const browser = await puppeteer.launch();
	const page = await browser.newPage();

	const client = await page.target().createCDPSession();
	const interceptManager = new RequestInterceptionManager(client);

	await interceptManager.intercept(
		{
			urlPattern: `*`,
			resourceType: 'Document',
			modifyResponse({ body }) {
				return {
					body: replaceBody(body),
				}
			},
		}
	);

	await page.goto(url.toString());

	const data = await page.evaluate(() => document.querySelector('*').innerHTML);
	// Print the full title
	console.log(data);

	await browser.close();
}

const url = new URL('https://superficial-delicious-stamp.glitch.me/js.js');
(async () => browseModifyAndCaptureSelector(url))();
