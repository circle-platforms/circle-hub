// U2 (decisions-1600): console forms generated from the shared command parameter registration
// (hub/server/command-parameters.ts). Pages pass DynamicChoices; argv comes from buildCommandArgv;
// sensitive stdin values stay out of argv and go through the command bridge's secrets map.
import {
  COMMAND_PARAMETERS,
  buildCommandArgv,
  commandParameterShape,
  type CommandParameterId,
  type DynamicChoices,
} from '../command-parameters.ts';
import { UsageError } from '../errors.ts';
import { postForm, selectControl, type SelectOption } from './components.ts';
import { html, type Html } from './html.ts';
import { field } from './presentation.ts';

export type { CommandParameterId, DynamicChoices };

/** Trimmed form fields (same contract as manage.Form). */
export type CommandForm = { get(name: string): string };

export interface CommandBuilt {
  argv: string[];
  secrets?: Record<string, string>;
}

/** ACTION name → registered command id for onboarding management that maps 1:1. */
export const REGISTERED_ACTIONS = {
  'user-create': 'user.create',
  'user-disable': 'user.disable',
  'user-enable': 'user.enable',
  'user-rename': 'user.rename',
  'password-reset': 'user.password-reset',
  'user-invite': 'user.invite',
  'token-issue': 'token.issue',
  'token-revoke': 'token.revoke',
  'team-create': 'team.create',
  'team-delete': 'team.delete',
  'team-add': 'team.add',
  'team-remove': 'team.remove',
  'pack-assign': 'pack.assign',
  'pack-unassign': 'pack.unassign',
  'pack-grant': 'pack.grant-publish',
  'pack-revoke': 'pack.revoke-publish',
  'pack-install': 'pack.install',
  'pack-uninstall': 'pack.uninstall',
  'pack-activate': 'pack.activate',
  'pack-deactivate': 'pack.deactivate',
  'pack-retire': 'pack.retire',
  'secret-set': 'secret.set',
  'secret-unset': 'secret.unset',
  'knowledge-sync': 'knowledge.sync',
  'executor-disable': 'executor.disable',
  'executor-add': 'executor.add',
  'executor-update': 'executor.update',
  'executor-assign': 'executor.assign',
  'executor-unassign': 'executor.unassign',
  'doc-put': 'doc.put',
  'lease-register': 'lease.register',
  'lease-unregister': 'lease.unregister',
  'lease-release': 'lease.release',
  'bed-baseline-record': 'bed.baseline.record',
  'bed-hold-clear': 'bed.hold.clear',
} as const satisfies Record<string, CommandParameterId>;

export type RegisteredActionName = keyof typeof REGISTERED_ACTIONS;

/** Management POSTs that accept a file and turn it into `--reference=src:…` before the bridge. */
export const UPLOAD_REFERENCE_ACTIONS = new Set<RegisteredActionName>(['executor-add', 'executor-update', 'doc-put']);

const isBooleanSchema = (schema: Record<string, unknown>): boolean => schema.type === 'boolean';

/** Visible fields for one registered command (no CSRF, no submit). Hidden options stay out. */
export function commandFields(
  id: CommandParameterId,
  choices: DynamicChoices = {},
  values: Record<string, string | readonly string[] | boolean> = {},
): Html {
  const shape = commandParameterShape(id, choices);
  const parts: Html[] = [];
  for (const item of shape.fields) {
    const current = values[item.name];
    const hint = item.description;
    if (item.choices !== undefined) {
      const selected = typeof current === 'string' ? current : '';
      const options: SelectOption[] = item.choices.map((row) => ({
        value: row.value,
        label: row.label,
        selected: row.value === selected,
      }));
      const blank = item.required ? undefined : { value: '', label: '（不填）', selected: selected === '' };
      parts.push(field(item.label, selectControl(item.name, options, blank), hint));
      continue;
    }
    if (isBooleanSchema(item.schema) && !item.multiple) {
      const on = current === true || current === '1' || current === 'true';
      parts.push(html`<label class="check" data-wide-field><input type="checkbox" name="${item.name}" value="1"${on ? html` checked` : ''}> ${item.label}</label>`);
      continue;
    }
    if (item.multiple) {
      const text = Array.isArray(current) ? current.join('\n') : typeof current === 'string' ? current : '';
      parts.push(field(item.label, html`<textarea name="${item.name}" rows="3"${item.required ? html` required` : ''}>${text}</textarea>`, `${hint}；每行一项`));
      continue;
    }
    const text = typeof current === 'string' ? current : '';
    parts.push(field(
      item.label,
      html`<input name="${item.name}" value="${text}"${item.required ? html` required` : ''} autocomplete="off">`,
      hint,
    ));
  }
  for (const stdin of shape.stdin) {
    if (stdin.key !== undefined) {
      parts.push(field(stdin.key, html`<input type="password" name="stdin:${stdin.key}" autocomplete="off">`, stdin.description));
      continue;
    }
    if (stdin.keysFromOption !== undefined) {
      parts.push(field('密钥内容', html`<input type="password" name="value" autocomplete="off">`, stdin.description));
    }
  }
  return html`<div data-fields data-command="${id}">${parts}</div>`;
}

/** A POST form to /console/admin/do/<action> whose fields come from the command registration. */
export function registeredActionForm(
  action: RegisteredActionName,
  csrf: string,
  submit: string,
  options: {
    choices?: DynamicChoices;
    values?: Record<string, string | readonly string[] | boolean>;
    primary?: boolean;
    hiddens?: Record<string, string>;
  } = {},
): Html {
  const id = REGISTERED_ACTIONS[action];
  const hidden = Object.entries(options.hiddens ?? {}).map(([name, value]) => html`<input type="hidden" name="${name}" value="${value}">`);
  return postForm({
    action: `/console/admin/do/${action}`,
    csrf,
    fields: html`${hidden}${commandFields(id, options.choices ?? {}, options.values ?? {})}`,
    submit,
    primary: options.primary ?? true,
  });
}

function readMultiple(raw: string): string[] {
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** A form value that becomes an argv word must not look like a flag (same rule as manage.word). */
function safeWord(value: string, label: string): string {
  if (value.startsWith('-') || /[\u0000-\u001f\u007f]/.test(value) || value.length > 512) {
    throw new UsageError(`${label}的写法不对`);
  }
  return value;
}

/** Read a field; hyphenated registration names also accept the underscore form used by older forms. */
function readField(form: CommandForm, name: string): string {
  const direct = form.get(name);
  if (direct !== '') return direct;
  if (name.includes('-')) return form.get(name.replaceAll('-', '_'));
  return '';
}

/** Form fields → argument object for buildCommandArgv (no secret values). */
export function valuesFromForm(id: CommandParameterId, form: CommandForm): Record<string, unknown> {
  const shape = commandParameterShape(id);
  const values: Record<string, unknown> = {};
  for (const item of shape.fields) {
    const raw = readField(form, item.name);
    if (isBooleanSchema(item.schema) && !item.multiple) {
      if (raw === '1' || raw === 'true' || raw === 'on') values[item.name] = true;
      continue;
    }
    if (raw === '') continue;
    // Positionals must not look like flags; option values may start with `-` (`--label=--raw`).
    const guard = item.location === 'positional'
      ? (value: string) => safeWord(value, item.label)
      : (value: string) => {
          if (/[\u0000-\u001f\u007f]/.test(value) || value.length > 512) throw new UsageError(`${item.label}的写法不对`);
          return value;
        };
    if (item.multiple) {
      values[item.name] = readMultiple(raw).map(guard);
      continue;
    }
    values[item.name] = guard(raw);
  }
  return values;
}

/** Sensitive stdin map for the bridge; empty when the command has no stdin binding. */
export function secretsFromForm(id: CommandParameterId, form: CommandForm): Record<string, string> | undefined {
  const shape = commandParameterShape(id);
  if (shape.stdin.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const stdin of shape.stdin) {
    if (stdin.key !== undefined) {
      const value = form.get(`stdin:${stdin.key}`);
      if (value === '') throw new UsageError(`请填写${stdin.key}`);
      out[stdin.key] = value;
      continue;
    }
    if (stdin.keysFromOption !== undefined) {
      const names = readMultiple(form.get(stdin.keysFromOption));
      if (names.length === 0) throw new UsageError('请填写密钥名');
      if (names.length === 1) {
        const value = form.get('value') || form.get(`stdin:${names[0]}`);
        if (value === '') throw new UsageError('请填写密钥的值');
        out[names[0]] = value;
        continue;
      }
      for (const name of names) {
        const value = form.get(`stdin:${name}`);
        if (value === '') throw new UsageError(`请填写密钥 ${name} 的值`);
        out[name] = value;
      }
    }
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** Build argv (and optional secrets) from the registration. */
export function buildRegistered(id: CommandParameterId, form: CommandForm): CommandBuilt {
  const argv = buildCommandArgv(id, valuesFromForm(id, form));
  const secrets = secretsFromForm(id, form);
  return secrets === undefined ? { argv } : { argv, secrets };
}

export function buildRegisteredAction(action: RegisteredActionName, form: CommandForm): CommandBuilt {
  return buildRegistered(REGISTERED_ACTIONS[action], form);
}

/** Every registered onboarding id the console form generator can render. */
export function registeredCommandIds(): CommandParameterId[] {
  return Object.keys(COMMAND_PARAMETERS) as CommandParameterId[];
}
