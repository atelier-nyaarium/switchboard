export const WORKFLOW_PRELUDE = `
(() => {
	const deny = () => { throw new Error("nondeterministic value is unavailable"); };
	const NativeDate = Date;
	globalThis.Date = new Proxy(NativeDate, {
		apply() { return deny(); },
		construct(target, args) {
			if (args.length === 0) return deny();
			return Reflect.construct(target, args);
		},
	});
	globalThis.Date.now = deny;
	Math.random = deny;
	delete globalThis.WeakRef;
	delete globalThis.FinalizationRegistry;
	globalThis.parallel = async function parallel(thunks) {
		if (!Array.isArray(thunks)) thunks = Array.from(arguments);
		return Promise.all(thunks.map(async (thunk) => {
			try { return await thunk(); } catch { return null; }
		}));
	};
	globalThis.pipeline = async function pipeline(value, ...steps) {
		if (Array.isArray(value) && steps.length === 0) {
			steps = value;
			value = undefined;
		}
		let current = value;
		for (const step of steps) {
			try { current = await step(current); } catch { current = null; }
		}
		return current;
	};
})();
`;
