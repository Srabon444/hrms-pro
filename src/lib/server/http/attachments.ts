import { fail } from '@sveltejs/kit';
import { addFiles, removeFile, replaceFile } from '../attachments';
import type { AttachmentOwner } from '../db/schema';
import type { requireMember } from '../rbac/access';
import { actionError, field } from './forms';

export const pickFiles = (form: FormData) =>
	form.getAll('files').filter((v): v is File => v instanceof File && v.size > 0);

export async function attachmentAction(
	m: ReturnType<typeof requireMember>,
	form: FormData,
	type: AttachmentOwner,
	id: string,
	requestId: string
) {
	try {
		const op = field(form, 'op');
		const fileId = field(form, 'fileId');
		if (op === 'remove') await removeFile(m, { type, id }, fileId);
		else if (op === 'replace') await replaceFile(m, { type, id }, fileId, pickFiles(form)[0] ?? new File([], ''));
		else await addFiles(m, type, id, pickFiles(form));
	} catch (err) {
		const failed = actionError(err, requestId);
		return fail(failed.status, { fileMessage: failed.data.message, fileOwner: id });
	}
	return { fileSaved: true, fileOwner: id };
}
