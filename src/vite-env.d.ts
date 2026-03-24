/// <reference types="vite/client" />

declare module 'satellite.js' {
	export const constants: {
		mu: number;
		earthRadius: number;
		[key: string]: unknown;
	};
}
