// Reset ACTIONS for the command bridge (K11 / answers-codex 17:15). Shapes stay here; manage.registerActions installs them.
import { FormError, registerActions, type Action, type Form } from './manage.ts';
import { isResetScope, RESET_CONFIRM_WORD } from './reset.ts';
import { settingsPath } from './routes.ts';

/** Result-page back link for reset (settings Hub tab). */
const SETTINGS_HUB = `${settingsPath()}?tab=hub#reset-rebuild`;

function buildReset(form: Form): { argv: string[] } {
  const confirm = form.get('confirm');
  if (confirm !== RESET_CONFIRM_WORD) throw new FormError(`请输入「${RESET_CONFIRM_WORD}」以确认`);
  const scope = form.get('scope');
  if (!isResetScope(scope)) throw new FormError('请选择重建范围');
  const argv = ['reset', `--scope=${scope}`];
  if (form.get('keep_config') === '1') argv.push('--keep-config');
  return { argv };
}

/** Keys for manage.ACTIONS; registered without editing manage.ts literals. */
export const RESET_ACTIONS: Readonly<Record<string, Action>> = {
  reset: {
    title: '重置和重建',
    back: SETTINGS_HUB,
    active: 'settings',
    build: buildReset,
  },
};

registerActions(RESET_ACTIONS);
