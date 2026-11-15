"""Controlled installer. Importing this module does not inspect a host or start a service."""
from __future__ import annotations

import argparse
import ast
from datetime import datetime, timedelta
import hashlib
import json
import os
import pwd
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

FILES = ('entry.py', 'cell_gateway.py', 'cell_runtime.py', 'table_cell.py', 'test_xlsx.py')
PREFIX = 'zz-value-pick-'


class InstallFailure(RuntimeError):
    def __init__(self, stage, reason, rollback=None):
        super().__init__(reason)
        self.stage, self.reason, self.rollback = stage, reason, rollback

    def report(self):
        return {'ok': False, 'stage': self.stage, 'reason': self.reason,
                **({'rollback': self.rollback} if self.rollback is not None else {})}


def run_process(argv, timeout=30, input=None):
    try:
        result = subprocess.run(argv, input=input, text=True, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        raise InstallFailure('command', 'command_timeout') from None
    except OSError:
        raise InstallFailure('command', 'command_unavailable') from None
    if result.returncode:
        raise InstallFailure('command', 'command_failed')
    return result.stdout.rstrip('\n')


def safe_path(value):
    if not isinstance(value, str) or not re.fullmatch(r'/[A-Za-z0-9_./-]+', value) or '..' in value or '//' in value:
        raise InstallFailure('discover', 'unsupported_path')
    return Path(value)


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def parse_launch(raw, working_directory):
    match = re.fullmatch(r'\{ path=([^ ;{}]+) ; argv\[\]=([^;{}]+) ; ignore_errors=(?:yes|no) ;[^{}]*\}', raw)
    if not match:
        raise InstallFailure('discover', 'unsupported_execstart')
    python = safe_path(match[1])
    argv = match[2].strip().split()
    if not argv or argv[0] not in (str(python), python.name):
        raise InstallFailure('discover', 'argv0_mismatch')
    if len(argv) == 6 and argv[1:5] == ['-m', 'gateway.cexg', 'serve', '--config']:
        root, config, component = safe_path(working_directory), safe_path(argv[5]), None
    elif len(argv) == 5 and argv[2:4] == ['serve', '--config'] and safe_path(argv[1]).name == 'cexg.py':
        root, config, component = safe_path(argv[1]).parent.parent, safe_path(argv[4]), None
    elif len(argv) == 9 and safe_path(argv[1]).name == 'entry.py' and argv[2:4] == ['serve', '--gateway-root'] and argv[5] == '--config' and argv[7] == '--contract':
        root, config, component = safe_path(argv[4]), safe_path(argv[6]), safe_path(argv[1]).parent
    else:
        raise InstallFailure('discover', 'unknown_launch_shape')
    return {'python': python, 'gateway_root': root, 'config': config,
            'component': component, 'argv': argv}


def dropin_text(argv):
    if not argv or any(not re.fullmatch(r'[A-Za-z0-9_./-]+', arg) for arg in argv):
        raise InstallFailure('dropin', 'unsupported_systemd_argument')
    return '[Service]\nExecStart=\nExecStart=' + ' '.join(argv) + '\n'


def framework_paths(config):
    # Read only the two explicitly named metadata fields; unknown/escaped/multiline forms fail closed.
    section, values = None, {}
    for line in Path(config).read_text(encoding='utf8').splitlines():
        line = line.strip()
        if line.startswith('['):
            section = line
        elif section == '[framework]' and re.match(r'^(apv_src|py38)\s*=', line):
            match = re.fullmatch(r'(apv_src|py38)\s*=\s*"([^"\\]+)"\s*(?:#.*)?', line)
            if not match or match[1] in values:
                raise InstallFailure('discover', 'framework_metadata_unsupported')
            values[match[1]] = safe_path(match[2])
    if set(values) != {'apv_src', 'py38'}:
        raise InstallFailure('discover', 'framework_metadata_missing')
    return values


def read_component_state(component):
    file = Path(component) / 'runtime/status.json'
    if file.is_symlink() or not file.is_file():
        raise InstallFailure('component_state', 'state_missing_or_not_regular')
    state = json.loads(file.read_text(encoding='utf8'))
    if not isinstance(state, dict) or set(state) != {'schema', 'mode', 'reason', 'recorded_at', 'pid'} or state['schema'] != 'value-pick-state@1' or state['mode'] not in ('cell', 'original') or not (state['reason'] is None or isinstance(state['reason'], str)):
        raise InstallFailure('component_state', 'state_shape_invalid')
    if type(state['pid']) is not int or state['pid'] <= 0:
        raise InstallFailure('component_state', 'state_pid_invalid')
    raw = state['recorded_at']
    if not isinstance(raw, str) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|\+00:00)', raw):
        raise InstallFailure('component_state', 'state_time_not_utc')
    when = datetime.fromisoformat(raw[:-1] + '+00:00' if raw.endswith('Z') else raw)
    if when.utcoffset() != timedelta(0):
        raise InstallFailure('component_state', 'state_time_not_utc')
    return state


class Installer:
    def __init__(self, systemctl='systemctl', runner=run_process, clock=time.monotonic,
                 sleep=time.sleep, timeout=30, stable_seconds=10):
        if not isinstance(timeout, (int, float)) or not 0 < timeout <= 3600:
            raise InstallFailure('arguments', 'timeout_invalid')
        if not isinstance(stable_seconds, (int, float)) or not 0 < stable_seconds <= 3600:
            raise InstallFailure('arguments', 'stable_seconds_invalid')
        self.stable_seconds = stable_seconds
        self.systemctl, self.runner, self.clock, self.sleep = systemctl, runner, clock, sleep
        self.timeout, self.stage = timeout, 'arguments'

    def call(self, argv, input=None):
        return self.runner([str(x) for x in argv], timeout=self.timeout, input=input)

    def show(self, unit, property):
        return self.call([self.systemctl, 'show', unit, '--property=' + property, '--value'])

    def unit(self, unit):
        if not isinstance(unit, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]*\.service', unit):
            raise InstallFailure('arguments', 'unit_invalid')

    def launch(self, unit):
        return parse_launch(self.show(unit, 'ExecStart'), self.show(unit, 'WorkingDirectory'))

    def number(self, unit, property):
        try:
            raw = self.show(unit, property)
            return int(raw) if re.fullmatch(r'[0-9]+', raw) else None
        except Exception:
            return None

    def running(self, unit, restart_baseline):
        # Observe start transitions, then a full stable interval; an automatic restart never gets another chance.
        if restart_baseline is None:
            return False
        deadline, previous = self.clock() + self.timeout, restart_baseline
        first_sample = True
        while True:
            count = self.number(unit, 'NRestarts')
            # An explicit restart resets this counter; a nonzero first sample already witnessed an auto restart.
            if count is None or (first_sample and count != 0) or count > previous:
                return False
            first_sample = False
            previous = count
            active, sub = self.show(unit, 'ActiveState'), self.show(unit, 'SubState')
            if active == 'active' and sub == 'running':
                pid = self.number(unit, 'MainPID')
                if pid is None or pid <= 0:
                    return False
                break
            if self.clock() >= deadline:
                return False
            self.sleep(min(.2, max(0, deadline - self.clock())))
        stable_until = self.clock() + self.stable_seconds
        while self.clock() < stable_until:
            self.sleep(min(.2, max(0, stable_until - self.clock())))
            count = self.number(unit, 'NRestarts')
            if count is None or count > previous:
                return False
            previous = count
            if self.show(unit, 'ActiveState') != 'active' or self.show(unit, 'SubState') != 'running' or self.number(unit, 'MainPID') != pid:
                return False
        return True

    def own_dropins(self, unit, release=None):
        paths = {safe_path(p) for p in self.show(unit, 'DropInPaths').split()}
        directory = safe_path(self.show(unit, 'FragmentPath')).parent / (unit + '.d')
        if directory.is_symlink():
            raise InstallFailure('identify', 'dropin_directory_symlink')
        paths.update(directory.glob(PREFIX + '*.conf'))
        return [p for p in paths if p.name.startswith(PREFIX) and p.name.endswith('.conf') and (release is None or p.name == PREFIX + release + '.conf')]

    def expected_dropin(self, launch, tag):
        component = launch['gateway_root'].parent / 'cell-runtime-releases' / tag
        if launch['component'] is not None and launch['component'] != component:
            raise InstallFailure('identify', 'component_identity_mismatch')
        argv = [str(launch['python']), str(component / 'entry.py'), 'serve', '--gateway-root', str(launch['gateway_root']), '--config', str(launch['config']), '--contract', str(component / 'excel-contract.json')]
        return dropin_text(argv)

    def status(self, unit):
        # Read-only and independent of bundle/checker/config contents. Never disclose discovered paths.
        self.unit(unit)
        before = {'active': None, 'sub': None}
        for field, property in (('active', 'ActiveState'), ('sub', 'SubState')):
            try:
                before[field] = self.show(unit, property) or None
            except Exception:
                pass
        launch = None
        try:
            launch = self.launch(unit)
        except Exception:
            pass
        result = {'ok': launch is not None, 'stage': 'status', 'entry': 'unknown', 'release': None, 'component_state': None, 'component_state_current': None,
                  'own_dropin': {'present': None, 'count': None, 'releases': None, 'content_matches': None},
                  'before': before, 'idle_checked': False, 'observer_required': False}
        if launch is not None:
            result['entry'] = 'wrapped' if launch['component'] is not None else 'original'
            if launch['component'] is not None:
                result['release'] = launch['component'].name
                try:
                    state = read_component_state(launch['component'])
                    current = self.number(unit, 'MainPID')
                    if current is None or current <= 0 or state['pid'] != current:
                        raise InstallFailure('component_state', 'state_pid_stale_or_unknown')
                    result['component_state'] = state
                    result['component_state_current'] = True
                except Exception:
                    result['component_state_current'] = False
                    result['ok'] = False
        try:
            owned = self.own_dropins(unit)
            result['own_dropin'].update(present=bool(owned), count=len(owned), releases=sorted({p.name[len(PREFIX):-5] for p in owned if re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]*', p.name[len(PREFIX):-5])}))
            if len(owned) == 1 and launch is not None:
                tag = owned[0].name[len(PREFIX):-5]
                result['own_dropin']['content_matches'] = not owned[0].is_symlink() and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]*', tag) is not None and owned[0].read_text(encoding='utf8') == self.expected_dropin(launch, tag)
        except Exception:
            result['ok'] = False
        return result

    def observe(self, bundle, plan, unit, launch, phase):
        checker = Path(bundle) / 'install/observe.py'
        if not checker.is_file() or checker.is_symlink() or sha(checker) != plan['checker_sha256']:
            raise InstallFailure(phase, 'checker_missing_or_identity_mismatch')
        request = {'operation': 'observe', 'unit': unit, 'phase': phase,
                   'gateway_root': str(launch['gateway_root']), 'config_path': str(launch['config'])}
        if launch['component'] is not None:
            request['component_root'] = str(launch['component'])
        facts = json.loads(self.call([sys.executable, checker], json.dumps(request)))
        if facts.get('schema') != 'value-pick-observation@1' or facts.get('verified') is not True:
            raise InstallFailure(phase, 'observation_unknown')
        if type(facts.get('jobs')) is not int or facts['jobs'] != 0 or facts.get('leased') is not False or facts.get('bed_busy') is not False:
            raise InstallFailure(phase, 'not_idle_or_unknown')
        if facts.get('version') != '0.4.7' or not isinstance(facts.get('tools'), list) or not facts['tools'] or any(not isinstance(t, str) for t in facts['tools']):
            raise InstallFailure(phase, 'version_or_tools_unknown')
        for key in ('task_inventory_sha256', 'request_records_sha256'):
            if not isinstance(facts.get(key), str) or not re.fullmatch(r'[a-f0-9]{64}', facts[key]):
                raise InstallFailure(phase, 'inventory_unknown')
        return facts

    def preflight(self, bundle, unit):
        self.unit(unit)
        bundle = Path(bundle)
        self.stage = 'manifest'
        plan = json.loads((bundle / 'install-plan.json').read_text(encoding='utf8'))
        if plan.get('missing_requirements'):
            raise InstallFailure(self.stage, 'bundle_inputs_missing')
        if plan.get('installer_sha256') is not None and sha(Path(__file__)) != plan['installer_sha256']:
            raise InstallFailure(self.stage, 'installer_identity_mismatch')
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]*', plan.get('release', '')) or not re.fullmatch(r'[0-9a-f]{40}', plan.get('source_commit', '')):
            raise InstallFailure(self.stage, 'release_or_commit_invalid')
        if set(plan.get('component_sha256', {})) != set(FILES):
            raise InstallFailure(self.stage, 'five_file_manifest_missing')
        for name in FILES:
            file = bundle / 'bed-side' / name
            if not file.is_file() or file.is_symlink() or sha(file) != plan['component_sha256'][name]:
                raise InstallFailure(self.stage, 'component_identity_mismatch')
        typed = bundle / 'base-hub-contract.json'
        if not typed.is_file() or sha(typed) != plan.get('base_hub_sha256'):
            raise InstallFailure(self.stage, 'base_typed_missing_or_mismatch')
        self.stage = 'discover'
        launch = self.launch(unit)
        if launch['component'] is not None:
            raise InstallFailure(self.stage, 'already_wrapped')
        paths = framework_paths(launch['config'])
        base = paths['apv_src'] / 'lib/excel_contract.json'
        document = json.loads(base.read_text(encoding='utf8'))
        available = {r.get('e', r.get('name')) for r in document['objects'] if r['status'] == 'enabled'}
        objects = plan.get('objects')
        if not isinstance(objects, list) or not objects or any(not isinstance(o, str) or o not in available for o in objects) or len(set(objects)) != len(objects):
            raise InstallFailure('preflight', 'objects_unproven')
        self.stage = 'preflight'
        facts = self.observe(bundle, plan, unit, launch, self.stage)
        if self.show(unit, 'ActiveState') != 'active' or self.show(unit, 'SubState') != 'running':
            raise InstallFailure(self.stage, 'service_not_running')
        return {'plan': plan, 'launch': launch, 'framework': paths, 'base': base,
                'typed': typed, 'facts': facts}

    def guard(self, bundle, state, unit):
        launch = self.launch(unit) if self.stage == 'postcheck' else state['launch']
        facts = self.observe(bundle, state['plan'], unit, launch, self.stage)
        if any(facts[key] != state['facts'][key] for key in ('task_inventory_sha256', 'request_records_sha256')):
            raise InstallFailure(self.stage, 'task_or_request_changed')
        return facts

    def install(self, bundle, unit):
        try:
            return self._install(bundle, unit)
        except InstallFailure as error:
            if error.stage == 'command':
                raise InstallFailure(self.stage, error.reason, error.rollback) from None
            raise
        except Exception:
            raise InstallFailure(self.stage, 'operation_failed') from None

    def _install(self, bundle, unit):
        state = self.preflight(bundle, unit)
        plan, launch = state['plan'], state['launch']
        version = launch['gateway_root'].parent / 'cell-runtime-releases' / plan['release']
        fragment = safe_path(self.show(unit, 'FragmentPath'))
        dropin = fragment.parent / (unit + '.d') / (PREFIX + plan['release'] + '.conf')
        if version.exists() or version.is_symlink() or dropin.exists() or dropin.is_symlink():
            raise InstallFailure('preflight', 'destination_exists')
        user = self.show(unit, 'User')
        if not user or self.show(unit, 'DynamicUser') != 'no':
            raise InstallFailure(self.stage, 'service_identity_unsupported')
        account = pwd.getpwnam(user)
        # Before activation, failures leave only the new version directory; old unit/contracts are untouched.
        self.stage = 'copy_version'; self.guard(bundle, state, unit)
        if not version.parent.exists():
            version.parent.mkdir(mode=0o755); os.chmod(version.parent, 0o755)
        version.mkdir(mode=0o755); os.chmod(version, 0o755)
        for name in FILES:
            shutil.copyfile(Path(bundle) / 'bed-side' / name, version / name)
            os.chmod(version / name, 0o644)
        runtime = version / 'runtime'
        runtime.mkdir(mode=0o700); os.chmod(runtime, 0o700); os.chown(runtime, account.pw_uid, account.pw_gid)
        self.stage = 'export_original'; self.guard(bundle, state, unit)
        objects = [v for obj in plan['objects'] for v in ('--object', obj)]
        self.call([state['framework']['py38'], '-B', version / 'entry.py', 'export-contract', '--framework-root', state['framework']['apv_src'], '--base-contract', state['base'], *objects, '--out', version / 'excel-contract.json'])
        self.stage = 'export_typed'; self.guard(bundle, state, unit)
        self.call([launch['python'], '-B', version / 'entry.py', 'export-hub-contract', '--original', version / 'excel-contract.json', '--base-hub-contract', state['typed'], '--out', version / 'hub-contract.json'])
        for file in (version / 'excel-contract.json', version / 'hub-contract.json'):
            os.chown(file, account.pw_uid, account.pw_gid); os.chmod(file, 0o600)
        argv = [str(launch['python']), str(version / 'entry.py'), 'serve', '--gateway-root', str(launch['gateway_root']), '--config', str(launch['config']), '--contract', str(version / 'excel-contract.json')]
        text = dropin_text(argv)
        self.stage = 'dropin'; self.guard(bundle, state, unit)
        dropin.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        activated = False
        try:
            temporary = None
            try:
                fd, name = tempfile.mkstemp(prefix='.value-pick-', dir=dropin.parent)
                temporary = Path(name)
                with os.fdopen(fd, 'w', encoding='utf8') as stream:
                    stream.write(text); stream.flush(); os.fsync(stream.fileno())
                os.link(temporary, dropin)
                activated = True
            finally:
                if temporary is not None:
                    temporary.unlink(missing_ok=True)
            self.stage = 'reload'; self.guard(bundle, state, unit)
            self.call([self.systemctl, 'daemon-reload'])
            self.stage = 'restart'; self.guard(bundle, state, unit)
            restart_baseline = self.number(unit, 'NRestarts')
            self.call([self.systemctl, 'restart', unit])
            if not self.running(unit, restart_baseline):
                raise InstallFailure(self.stage, 'service_not_stable')
            self.stage = 'postcheck'
            after = self.guard(bundle, state, unit)
            if not isinstance(after.get('component_state'), dict) or after['component_state'].get('mode') != 'cell':
                raise InstallFailure(self.stage, 'component_not_cell')
            if set(after['tools']) != set(state['facts']['tools']) | {'case_submit_cell'}:
                raise InstallFailure(self.stage, 'tools_changed')
            return {'ok': True, 'stage': 'installed', 'component_sha256': plan['component_sha256']}
        except Exception as error:
            failed = self.stage
            restored = self.rollback(unit, plan['release']) if activated else None
            reason = error.reason if isinstance(error, InstallFailure) else 'operation_failed'
            raise InstallFailure(failed, reason, restored) from None

    def rollback(self, unit, release=None):
        # Emergency path: NO PLAN/checker/config/idle/running prerequisite. Only own exact drop-in.
        self.unit(unit)
        before = {'active': None, 'sub': None}
        for field, property in (('active', 'ActiveState'), ('sub', 'SubState')):
            try:
                before[field] = self.show(unit, property) or None
            except Exception:
                pass  # Observation is best-effort, never an emergency rollback prerequisite.
        disclosure = {'before': before, 'idle_checked': False, 'observer_required': False}
        removed, stage = False, 'rollback_identify'
        try:
            launch = self.launch(unit)
            owned = self.own_dropins(unit, release)
            if len(owned) != 1:
                raise InstallFailure(stage, 'own_dropin_not_unique')
            own = owned[0]
            tag = own.name[len(PREFIX):-5]
            if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]*', tag) or release is not None and tag != release:
                raise InstallFailure(stage, 'release_mismatch')
            if own.is_symlink() or not own.is_file() or own.read_text(encoding='utf8') != self.expected_dropin(launch, tag):
                raise InstallFailure(stage, 'own_dropin_content_mismatch')
            stage = 'rollback_remove'; own.unlink(); removed = True
            stage = 'rollback_reload'; self.call([self.systemctl, 'daemon-reload'])
            stage = 'rollback_restart'
            restart_baseline = self.number(unit, 'NRestarts')
            self.call([self.systemctl, 'restart', unit])
            stage = 'rollback_wait'
            if not self.running(unit, restart_baseline):
                raise InstallFailure(stage, 'service_not_stable')
            stage = 'rollback_verify'
            if self.launch(unit)['component'] is not None:
                raise InstallFailure(stage, 'original_entry_not_restored')
            return {'ok': True, 'stage': 'rolled_back', 'removed': True, 'restored': True, 'version_files_retained': True, **disclosure}
        except Exception as error:
            return {'ok': False, 'stage': stage, 'removed': removed, 'restored': False, **disclosure,
                    'reason': error.reason if isinstance(error, InstallFailure) else 'rollback_operation_failed'}


def main():
    parser = argparse.ArgumentParser(description='Controlled cell-component installation; preflight is read-only')
    parser.add_argument('operation', choices=['preflight', 'install', 'rollback', 'status'])
    parser.add_argument('--unit', required=True)
    parser.add_argument('--bundle', type=Path)
    parser.add_argument('--release')
    parser.add_argument('--timeout', type=float, default=30)
    parser.add_argument('--stable-seconds', type=float, default=10)
    args = parser.parse_args()
    installer = Installer(timeout=args.timeout, stable_seconds=args.stable_seconds)
    try:
        if args.operation == 'status':
            answer = installer.status(args.unit)
        elif args.operation == 'rollback':
            answer = installer.rollback(args.unit, args.release)
        elif args.bundle is None:
            raise InstallFailure('arguments', 'bundle_required')
        elif args.operation == 'preflight':
            state = installer.preflight(args.bundle, args.unit)
            answer = {'ok': True, 'stage': 'preflight_only_stop_for_review', 'version': state['facts']['version'], 'jobs': 0, 'leased': False, 'component_sha256': state['plan']['component_sha256']}
        else:
            answer = installer.install(args.bundle, args.unit)
    except InstallFailure as error:
        answer = error.report()
    except Exception:
        answer = {'ok': False, 'stage': installer.stage, 'reason': 'operation_failed'}
    print(json.dumps(answer, ensure_ascii=False))
    return 0 if answer['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
