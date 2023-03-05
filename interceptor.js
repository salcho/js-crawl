const { RequestCollector, CookieCollector, BaseCollector} = require('tracker-radar-collector');
const parse = require('esprima').parse;
const generate = require('escodegen').generate;
const replace = require('ast-replace');
const typeBuilders = require('ast-types').builders;

class Interceptor extends BaseCollector {
	constructor() {
		super();
	}

	id() {
		'interceptor';
	}

	async addTarget({cdpClient}) {
		// enable interception of requests *in the response stage*
		await cdpClient.send("Fetch.enable", {
			patterns: [{ requestStage: "Response" }]
		  });

        
        // funnel all intercepted requests
		await Promise.all([
			cdpClient.on('Fetch.requestPaused', data => this.handlePausedRequest(data, cdpClient))
		]);
	}

	// data is https://chromedevtools.github.io/devtools-protocol/tot/Fetch/#event-requestPaused
	async handlePausedRequest(data, cdpClient) {
        // we're in the response stage, so we can simply get the body
		const originalBody = await cdpClient.send('Fetch.getResponseBody', {
			requestId: data.requestId
		});

        // TODO: add content types to this filter
		const hasScripts = data.responseHeaders.some(h => h.name === "content-type" && h.value.includes('text/html'));
        let body = originalBody.body;
        if (hasScripts) {
			if (originalBody.base64Encoded) {
				body = Buffer.from(body, 'base64').toString();
			}

			// instrument JS
			body = this.replaceBody(body);

			if (originalBody.base64Encoded) {
				body = btoa(body);
			}
		}

		await cdpClient.send('Fetch.fulfillRequest', {
			requestId: data.requestId,
			responseCode: data.responseStatusCode,
			body
		});
	}

	replaceBody(body) {
		const ast = replace(parse(body), {
			MemberExpression: {
				test: node => node.computed,
				replace: this.replaceMemberExpression.bind(this)
			}
		});
		return generate(ast);
	}
	
	replaceMemberExpressionForBinary(binary) {
		if (binary.left.type === 'MemberExpression') {
			binary.left = this.replaceMemberExpression(binary.left);
		}
	
		if (binary.right.type === 'MemberExpression') {
			binary.right = this.replaceMemberExpression(binary.right);
		}
	
		return binary;
	}

	// esprima only matches the top level MemberExpression, even when they're nested
	// for example obj[a][b], so this function must be recursive
	replaceMemberExpression(node) {
		// deal with `obj[a]` when `obj[a][b]`
		if (node.object.type === 'MemberExpression') {
			node.object = this.replaceMemberExpression(node.object);
		}
	
		switch (node.property.type) {
			// deal with `obj[a]` when `obj[obj[a]]`
			case 'MemberExpression':
				node.property = this.replaceMemberExpression(node.property);
				break;
			// deal with `obj[b]` when `obj[a + obj[b]]`, on either side of the plus
			case 'BinaryExpression':
				node.property = this.replaceMemberExpressionForBinary(node.property);
				break;
			default:
			// fall through
		}
	
		const call = typeBuilders.callExpression(typeBuilders.identifier('foo'), [node.property]);
		node.property = call;
		return node;
	}
}

module.exports = Interceptor;