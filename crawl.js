const { crawler } = require('tracker-radar-collector');
const Interceptor = require('./interceptor');

function peekAtArgument() {
	return () => {
		function peek(arg) {
			if (typeof arg !== "string") {
				return arg;
			}

			if ("__proto__" === arg || "constructor" === arg) {
				// call metrics
				window.navigator.sendBeacon("http://localhost:8081/me", JSON.stringify({ arg, url: window.location.href }));
			}

			return arg;
		}
		// make the reporting function available to everyone
		Object.defineProperty(window, "peekz", { visible: false, enumerable: false, writable: false, value: peek });
	}
}

async function letsGo({ url, callbackName}) {
	await crawler(url, {
		collectors: [new Interceptor(callbackName)],
		log: (...msg) => msg.forEach(x => console.log(x)),
		emulateMobile: false,
		emulateUserAgent: true,
		runInEveryFrame: peekAtArgument(),// function that should be executed in every frame (main + all subframes)
		maxLoadTimeMs: 30000,// how long should the crawler wait for the page to load, defaults to 30s
		extraExecutionTimeMs: 2500,// how long should crawler wait after page loads before collecting data, defaults to 2.5s);
	});
}

const url = new URL('https://superficial-delicious-stamp.glitch.me/js.htm');
letsGo({ url, callbackName: "peekz" });