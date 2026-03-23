/// <reference types="vite/client" />

declare module 'satellite.js' {
	export const draconian: {
		GM: number;
		Re: number;
		[key: string]: unknown;
	};
}

declare module 'mathjs' {
	export const physicalConstants: {
		c: unknown;
		solarConstant: unknown;
		[key: string]: unknown;
	};
}
