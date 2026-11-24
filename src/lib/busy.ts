import type { SubmitFunction } from '$app/forms';

export const whileBusy =
	(set: (busy: boolean) => void): SubmitFunction =>
	() => {
		set(true);
		return async ({ update }) => {
			try {
				await update();
			} finally {
				set(false);
			}
		};
	};
