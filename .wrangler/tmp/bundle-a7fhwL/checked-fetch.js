const urls = new Set();

/**
 * Checks if a given request URL has a custom port and logs a warning if it does.
 *
 * This function determines whether the provided request has a custom port other than 443
 * and uses the HTTPS protocol. If such a condition is met, it checks if the URL has already
 * been logged; if not, it adds the URL to a set and logs a warning about an issue with
 * `fetch()` requests to custom HTTPS ports in published Workers.
 *
 * @param {Request|string} request - The request object or string URL to be checked.
 * @param {Object} init - Optional initialization options for the Request if `request` is a string.
 */
function checkURL(request, init) {
	const url =
		request instanceof URL
			? request
			: new URL(
					(typeof request === "string"
						? new Request(request, init)
						: request
					).url
				);
	if (url.port && url.port !== "443" && url.protocol === "https:") {
		if (!urls.has(url.toString())) {
			urls.add(url.toString());
			console.warn(
				`WARNING: known issue with \`fetch()\` requests to custom HTTPS ports in published Workers:\n` +
					` - ${url.toString()} - the custom port will be ignored when the Worker is published using the \`wrangler deploy\` command.\n`
			);
		}
	}
}

globalThis.fetch = new Proxy(globalThis.fetch, {
	apply(target, thisArg, argArray) {
		const [request, init] = argArray;
		checkURL(request, init);
		return Reflect.apply(target, thisArg, argArray);
	},
});
