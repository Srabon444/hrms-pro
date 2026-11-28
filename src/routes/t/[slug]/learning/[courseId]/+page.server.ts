import {
	addLesson,
	addQuestion,
	allowRetry,
	assignCourse,
	completeLesson,
	coursePage,
	removeAssignment,
	removeLesson,
	removeQuestion,
	saveCourse,
	setCourseStatus,
	submitQuiz
} from '#lib/server/learning.ts';
import { attachmentAction } from '#lib/server/http/attachments.ts';
import { employeeActionError as failed, formFields } from '#lib/server/http/employee-form.ts';
import { field } from '#lib/server/http/forms.ts';
import { requireModule } from '#lib/server/modules.ts';
import { userCtx } from '#lib/server/rbac/access.ts';
import { withTenant } from '#lib/server/tenancy/index.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const m = await requireModule(locals, 'learning');
	return withTenant(userCtx(m), (tx) => coursePage(tx, m.access, params.courseId));
};

const run =
	(
		fn: (m: Awaited<ReturnType<typeof requireModule>>, form: Record<string, string>) => Promise<unknown>,
		done: string
	) =>
	async ({ request, locals, params }: { request: Request; locals: App.Locals; params: { courseId: string } }) => {
		const m = await requireModule(locals, 'learning');
		const form = { ...formFields(await request.formData()), courseId: params.courseId };
		try {
			await fn(m, form);
		} catch (err) {
			return failed(err, locals.requestId, form);
		}
		return { done };
	};

export const actions: Actions = {
	save: run((m, f) => saveCourse(m, f), 'Course saved.'),
	status: run((m, f) => setCourseStatus(m, f), 'Status changed.'),
	lesson: run((m, f) => addLesson(m, f), 'Lesson added.'),
	dropLesson: run((m, f) => removeLesson(m, f.lessonId ?? ''), 'Lesson removed.'),
	question: run((m, f) => addQuestion(m, f), 'Question added.'),
	dropQuestion: run((m, f) => removeQuestion(m, f.questionId ?? ''), 'Question removed.'),
	assign: async ({ request, locals, params }) => {
		const m = await requireModule(locals, 'learning');
		const form = { ...formFields(await request.formData()), courseId: params.courseId };
		try {
			const n = await assignCourse(m, form);
			return { done: `Course assigned. ${n} ${n === 1 ? 'person was' : 'people were'} added.` };
		} catch (err) {
			return failed(err, locals.requestId, form);
		}
	},
	unassign: run((m, f) => removeAssignment(m, f.assignmentId ?? ''), 'Assignment removed.'),
	retry: run((m, f) => allowRetry(m, f.enrolmentId ?? ''), 'Another try allowed.'),
	complete: run((m, f) => completeLesson(m, f), 'Lesson done.'),
	quiz: async ({ request, locals, params }) => {
		const m = await requireModule(locals, 'learning');
		const form = await request.formData();
		const picked = new Map<string, string[]>();
		for (const [key, value] of form.entries())
			if (key.startsWith('q:') && typeof value === 'string')
				picked.set(key.slice(2), [...(picked.get(key.slice(2)) ?? []), value]);
		try {
			const result = await submitQuiz(m, { lessonId: field(form, 'lessonId'), courseId: params.courseId }, picked);
			return { quiz: { lessonId: field(form, 'lessonId'), ...result } };
		} catch (err) {
			return failed(err, locals.requestId, {});
		}
	},
	lessonFiles: async ({ request, locals }) => {
		const m = await requireModule(locals, 'learning');
		const form = await request.formData();
		return attachmentAction(m, form, 'course_lesson', field(form, 'ownerId'), locals.requestId);
	}
};
