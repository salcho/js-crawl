const { BaseCollector} = require('tracker-radar-collector');
const jsdom = require('jsdom');
const parse = require('esprima').parse;
const generate = require('escodegen').generate;
const replace = require('ast-replace');
const typeBuilders = require('ast-types').builders;

class Interceptor extends BaseCollector {

    // list of content types we want to inspect and instrument
    // these values are used each in an `includes` call to the actual content type header
    SCRIPT_CONTENT_TYPES = [
        {includes: 'text/html', isHTML: true},
        {includes: 'text/javascript', isHTML: false}
    ];

	constructor(reportTo) {
		super();
		// the *name* of the function that has been made available on the global scope
		this.callback = reportTo;
	}

	id() {
		'interceptor';
	}

	async addTarget({cdpClient, page}) {
		// enable interception of responses with scripts in the response stage
		await cdpClient.send("Fetch.enable", {
			patterns: [
				{ requestStage: "Response", resourceType: "Document" },
				{ requestStage: "Response", resourceType: "Script" },
			]
		  });
        
        // funnel all intercepted requests
		await Promise.all([
			cdpClient.on('Fetch.requestPaused', data => this.handlePausedRequest(data, cdpClient))
		]);
	}

	// data is https://chromedevtools.github.io/devtools-protocol/tot/Fetch/#event-requestPaused
	async handlePausedRequest(data, cdpClient) {
		// we're in the response stage, so we can simply get the body
		// TODO: this command will fail if the headers haven't been received yet
		const originalBody = await cdpClient.send('Fetch.getResponseBody', {
			requestId: data.requestId
		});

        let body = this.maybeModifyResponse(originalBody, data.responseHeaders);

		await cdpClient.send('Fetch.fulfillRequest', {
			requestId: data.requestId,
			responseCode: data.responseStatusCode,
			body
		});
	}

    maybeModifyResponse(originalBody, responseHeaders) {
        const contentType = responseHeaders.find(h => h.name === "content-type" && this.SCRIPT_CONTENT_TYPES.some(ct => h.value.includes(ct.includes)));
        if (!contentType) {
            return originalBody.body;
        }

        let body = originalBody.body;
        if (originalBody.base64Encoded) {
            body = Buffer.from(body, 'base64').toString();
        }

        // instrument JS
        body = this.extractScripts(body, contentType.value);

        if (originalBody.base64Encoded) {
            body = btoa(body);
        }

        return body;
    }

    extractScripts(body, responseContentType) {
        const contentType = this.SCRIPT_CONTENT_TYPES.find(ct => responseContentType.includes(ct.includes))
        
        if (contentType.isHTML) {
            const dom = new jsdom.JSDOM(body);
            const inlineScripts = Array.from(dom.window.document.querySelectorAll('script'))
                // is inline script
                .filter(s => !s.hasAttribute('src'))
                // instrument
                .forEach(s => s.text = this.instrumentJavascipt(s.text));

            return dom.serialize();
        }

        // otherwise it's javascript
        return this.instrumentJavascipt(body);
    }

	instrumentJavascipt(body) {
		const ast = replace(parse(body), {
			MemberExpression: {
				test: node => node.computed,
				replace: this.replaceMemberExpression.bind(this)
			}
		});

        return generate(ast);
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
	
		const call = typeBuilders.callExpression(typeBuilders.identifier(this.callback), [node.property]);
		node.property = call;
		return node;
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
}

module.exports = Interceptor;