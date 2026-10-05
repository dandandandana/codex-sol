import { z } from 'zod';

const relativeFile = z.string().min(1).max(256).refine(value => /^[A-Za-z0-9_.\-/]+$/u.test(value) && !value.startsWith('/') && value.split('/').every(p => p && p !== '.' && p !== '..'), 'Expected a relative fixture file');
const identifier = z.string().regex(/^[A-Za-z_$][\w$]*$/u);
export const taskSchema = z.object({
  id: z.string().regex(/^T0[1-8]$/u), title: z.string().min(1).max(200), prompt: z.string().min(1).max(16000),
  entry: relativeFile, export_name: identifier, allowed_paths: z.array(relativeFile).min(1).max(8),
  reuse: z.array(z.object({ id: identifier, path: relativeFile, export_name: identifier, min_calls: z.number().int().min(1).max(100) }).strict()).max(8),
  api: z.object({ module_id: identifier, path: relativeFile, exports: z.array(identifier).min(1).max(8), options: z.array(identifier).optional() }).strict(),
}).strict();
export const corpusSchema = z.object({ schema_version: z.literal(1), benchmark_id: z.literal('sol-self-eval-v1'), cases: z.array(taskSchema).length(8) }).strict().superRefine((value, ctx) => {
  if (new Set(value.cases.map(c => c.id)).size !== 8) ctx.addIssue({ code: 'custom', message: 'Cases must have unique IDs' });
  for (const task of value.cases) {
    if (!task.allowed_paths.includes(task.entry) || !task.allowed_paths.includes('components.json')) ctx.addIssue({ code: 'custom', message: 'Entry and registry must be in allowed_paths' });
    if (new Set(task.reuse.map(r => r.id + ':' + r.export_name)).size !== task.reuse.length) ctx.addIssue({ code: 'custom', message: 'Reuse opportunities must be unique' });
  }
});
export const runSchema = z.object({ schema_version: z.literal(1), benchmark_id: z.literal('sol-self-eval-v1'), bundle_sha256: z.string().regex(/^[a-f0-9]{64}$/u), case_ids: z.array(z.string().regex(/^T0[1-8]$/u)).min(1).max(8), created_at: z.string().datetime() }).strict().refine(v => new Set(v.case_ids).size === v.case_ids.length, 'Case IDs must be unique');
export const registrySchema = z.object({ schema_version: z.literal(1), modules: z.array(z.object({ id: identifier, path: relativeFile, exports: z.array(identifier).min(1).max(16), options: z.array(identifier).optional() }).strict()).min(1).max(16) }).strict().refine(v => new Set(v.modules.map(m => m.id)).size === v.modules.length && new Set(v.modules.map(m => m.path)).size === v.modules.length, 'Module identity and paths must be unique');
