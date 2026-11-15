"""Assemble a private runner without changing the shared framework files."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import inspect
import json
import sys
import types
from pathlib import Path

from table_cell import CELL_EFFECT, PARAMETER_ROLES, PARAMETER_TYPES, table_cell

COMPONENT_ROOT = Path(__file__).resolve().parent
COMPONENT_FILES = ('entry.py', 'cell_runtime.py', 'cell_gateway.py',
                   'table_cell.py', 'test_xlsx.py')
SOURCE_PREFIX = 'cell-runtime/'
CELL_METHOD_SOURCE = SOURCE_PREFIX + 'cell_runtime.py'
VERSION = '1.0.0'
HUB_FIELDS = ('types', 'roles', 'effects', 'promotions', 'cleanup', 'destructive',
              'exec_failure_markers', 'refused_access')
RUNTIME_FIELDS = ('block_model', 'checkpoint_two_argument')


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(',', ':')).encode('utf-8')


def contract_digest(document):
    return hashlib.sha256(canonical({
        key: value for key, value in document.items()
        if key != 'contract_sha256'
    })).hexdigest()


def file_digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def copy_function(function, namespace):
    result = types.FunctionType(function.__code__, namespace, function.__name__,
                                function.__defaults__, function.__closure__)
    result.__kwdefaults__ = function.__kwdefaults__
    result.__annotations__ = function.__annotations__
    result.__dict__.update(function.__dict__)
    return result


def runner_namespace(module, contract):
    namespace = dict(vars(module))
    for name, value in vars(module).items():
        if inspect.isfunction(value) and value.__module__ == module.__name__:
            namespace[name] = copy_function(value, namespace)
    namespace['_load_excel_contract'] = lambda: contract
    return namespace


def export_contract(framework_root, base_contract, objects):
    root = Path(framework_root).resolve()
    # Export reads declared source bytes; framework and fixture imports may open device sessions.
    verified_base = json.loads((root / 'lib/excel_contract.json').read_text(encoding='utf-8'))
    supplied_base = json.loads(Path(base_contract).read_text(encoding='utf-8'))
    if (canonical(verified_base) != canonical(supplied_base)
            or verified_base.get('schema') != 'ist.excel.function-contract'
            or verified_base.get('complete') is not True
            or contract_digest(verified_base) != verified_base.get('contract_sha256')):
        raise ValueError('指定原规则与原入口实际加载的规则不同')
    sources = dict(verified_base['source_hashes'])
    for relative, expected in sources.items():
        path = (root / relative).resolve()
        if root not in path.parents or file_digest(path) != expected:
            raise ValueError('原规则声明的来源文件与实际内容不同')
    for relative in ('lib/test_xlsx.py', 'smoke_test/conftest.py'):
        if relative not in sources:
            raise ValueError('原规则缺少入口或设备工厂的来源声明')
    for entry in verified_base['entries']:
        if entry.get('source', {}).get('path') not in sources:
            raise ValueError('原规则的方法来源未登记文件摘要')
    if (verified_base['runtime']['runner_source'] != 'lib/test_xlsx.py'
            or verified_base['runtime']['runner_sha256'] != sources['lib/test_xlsx.py']):
        raise ValueError('原规则的入口身份与来源声明不同')
    document = copy.deepcopy(verified_base)
    available = {item.get('e', item.get('name')) for item in document['objects']
                 if item['status'] == 'enabled'}
    if not objects or any(name not in available for name in objects):
        raise ValueError('取格对象须来自原规则已声明且启用的对象')
    for name in COMPONENT_FILES:
        sources[SOURCE_PREFIX + name] = file_digest(COMPONENT_ROOT / name)
    public_method = CellDevice(None).table_cell
    signature = inspect.signature(public_method)
    parameters = []
    for parameter in signature.parameters.values():
        variadic = parameter.kind in (parameter.VAR_POSITIONAL, parameter.VAR_KEYWORD)
        parameters.append({
            'name': parameter.name,
            'kind': parameter.kind.name.lower(),
            'required': parameter.default is parameter.empty and not variadic,
            'default': None if parameter.default is parameter.empty else repr(parameter.default),
        })
    source_line = inspect.getsourcelines(public_method)[1]
    for name in objects:
        document['entries'].append({
            'e': name, 'f': 'table_cell',
            'python_symbol': 'cell_runtime.CellDevice.table_cell',
            'signature': {
                'parameters': parameters,
                'required': [item['name'] for item in parameters if item['required']],
                'optional': [item['name'] for item in parameters if not item['required']],
                'text': str(signature),
            },
            'g_syntax': 'Readable table shape and exact column equality arguments',
            'h_semantics': 'Stores the selected cell text unchanged',
            'i_semantics': 'Uses a saved device output as the first positional argument',
            'dispatch': 'direct_method_call', 'status': 'enabled', 'reason': '',
            'status_authority': 'project_policy:excel-authoring-v1',
            'source': {'path': CELL_METHOD_SOURCE, 'line': source_line},
            'minimum_runtime': document['runtime']['minimum_version'],
            'parameter_roles': PARAMETER_ROLES,
            'parameter_types': PARAMETER_TYPES,
            'cell_effect': CELL_EFFECT,
        })
    document['source_hashes'] = sources
    document['runtime']['runner_source'] = SOURCE_PREFIX + 'test_xlsx.py'
    document['runtime']['runner_sha256'] = sources[SOURCE_PREFIX + 'test_xlsx.py']
    document['atlas_snapshot']['cell_runtime'] = {
        'version': VERSION, 'base_contract_sha256': verified_base['contract_sha256'],
    }
    document['contract_sha256'] = contract_digest(document)
    return document


def original_of(document):
    result = {key: copy.deepcopy(value) for key, value in document.items()
              if key not in HUB_FIELDS + ('schema', 'contract_sha256', 'original')}
    for entry in result['entries']:
        entry.pop('typed_authority', None)
    for key in RUNTIME_FIELDS:
        result['runtime'].pop(key, None)
    result['schema'] = 'ist.excel.function-contract'
    result['contract_sha256'] = document['original']['contract_sha256']
    return result


def export_hub_contract(original_path, base_hub_path):
    raw = Path(original_path).read_bytes()
    original = json.loads(raw)
    base = json.loads(Path(base_hub_path).read_text(encoding='utf-8'))
    restored = original_of(base)
    base_identity = original['atlas_snapshot']['cell_runtime']['base_contract_sha256']
    if (base['schema'] != 'runtime-contract@2'
            or contract_digest(original) != original['contract_sha256']
            or contract_digest(base) != base['contract_sha256']
            or contract_digest(restored) != base_identity
            or base['original']['contract_sha256'] != base_identity):
        raise ValueError('新原件与旧Hub规则的原始来源不对应')
    document = copy.deepcopy(original)
    document['schema'] = 'runtime-contract@2'
    document['original'] = {
        'contract_sha256': original['contract_sha256'],
        'sha256': hashlib.sha256(raw).hexdigest(),
    }
    for field in HUB_FIELDS:
        if field in base:
            document[field] = copy.deepcopy(base[field])
    for field in RUNTIME_FIELDS:
        if field in base['runtime']:
            document['runtime'][field] = copy.deepcopy(base['runtime'][field])
    prior = {(entry['e'], entry['f']): entry for entry in base['entries']}
    same = set()
    for entry in document['entries']:
        old = prior.get((entry['e'], entry['f']))
        if old is None:
            continue
        source = entry.get('source', {}).get('path')
        if (source and entry.get('source') == old.get('source')
                and entry['signature'] == old['signature']
                and entry.get('python_symbol') == old.get('python_symbol')
                and original['source_hashes'].get(source) == base['source_hashes'].get(source)
                and source in original['source_hashes']):
            same.add((entry['e'], entry['f']))
            if 'typed_authority' in old:
                entry['typed_authority'] = copy.deepcopy(old['typed_authority'])
    if 'promotions' in document:
        document['promotions'] = [item for item in document['promotions']
                                  if (item['object'], item['method']) in same]
    for field in ('cleanup', 'destructive', 'exec_failure_markers', 'refused_access'):
        value = document.get(field)
        if (value and value.get('source') in original['source_hashes']
                and original['source_hashes'][value['source']] != value.get('sha256')):
            document.pop(field)

    cells = [(index, entry) for index, entry in enumerate(document['entries'])
             if entry['f'] == 'table_cell'
             and entry.get('source', {}).get('path') == CELL_METHOD_SOURCE]
    if not cells:
        raise ValueError('新原件没有取格方法的明确源声明')
    reference = 'src:' + document['original']['sha256'] + '/json@1/p/entries/' + str(cells[0][0])
    document.setdefault('types', {})
    for kind, parameter in (('string', 'output'), ('int', 'columns')):
        name = 'cell_' + kind
        document['types'][name] = {'declaration': {
            'name': name, 'declaration': reference + '/parameter_types/' + parameter,
            'grammar': 'runtime-contract@2', 'catalog_type': kind,
        }}
    document.setdefault('roles', {})
    for role, parameter in (('cell_source', 'output'), ('cell_selection', 'conditions')):
        document['roles'][role] = {'source': reference + '/parameter_roles/' + parameter}
    effect = cells[0][1]['cell_effect']
    document.setdefault('effects', {})['cell_selection'] = {
        'source': reference + '/cell_effect', 'roles': effect['roles'],
        'budget': effect['budget'], 'allowed_literals': [], 'command_roles': [],
    }
    for index, entry in cells:
        source = 'src:' + document['original']['sha256'] + '/json@1/p/entries/' + str(index)
        entry['typed_authority'] = {
            'source': source + '/cell_effect',
            'parameters': {
                name: {'type': 'cell_' + kind, 'role': entry['parameter_roles'][name]}
                for name, kind in entry['parameter_types'].items()
            },
            'effects': ['cell_selection'],
        }
    block = document['runtime']['block_model']
    block['cell_methods'] = [{'object': entry['e'], 'method': entry['f']} for _, entry in cells]
    block['cell_inputs'] = True
    block['output_methods'] = block.get('output_methods', []) + [
        {'object': entry['e'], 'method': entry['f'], 'output': 'cell_text'}
        for _, entry in cells
    ]
    document['contract_sha256'] = contract_digest(document)
    return document


def read_contract(path, framework_root, entry_path=None):
    document = json.loads(Path(path).read_text(encoding='utf-8'))
    if document['schema'] != 'ist.excel.function-contract' or document['complete'] is not True:
        raise ValueError('独立入口需要完整的原格式执行器规则')
    if contract_digest(document) != document['contract_sha256']:
        raise ValueError('独立执行器规则的内容与身份不同')
    runner = SOURCE_PREFIX + 'test_xlsx.py'
    if (document['runtime']['runner_source'] != runner
            or document['runtime']['runner_sha256'] != document['source_hashes'].get(runner)):
        raise ValueError('独立入口的源文件身份不一致')
    framework = Path(framework_root).resolve()
    for source, expected in document['source_hashes'].items():
        own = source.startswith(SOURCE_PREFIX)
        root = COMPONENT_ROOT if own else framework
        relative = source[len(SOURCE_PREFIX):] if own else source
        location = root / relative
        if location.is_symlink() or root not in location.resolve().parents:
            raise ValueError('规则源码不在声明范围内')
        if own and relative == 'test_xlsx.py' and entry_path is not None:
            location = Path(entry_path)
        if file_digest(location) != expected:
            raise ValueError('独立入口实际加载文件与执行器规则不一致：' + source)
    return document


class CellDevice:
    def __init__(self, device):
        self._device = device

    def __getattr__(self, name):
        return getattr(self._device, name)

    def table_cell(self, output, *conditions, separator, columns, column,
                   format='delimited', header=0, row=0) -> str:
        return table_cell(output, *conditions, separator=separator, columns=columns,
                          column=column, format=format, header=header, row=row)


class Runtime:
    def __init__(self, framework_root, contract_path, entry_path=None):
        self.framework_root = Path(framework_root).resolve()
        self.contract_path = Path(contract_path).resolve()
        self.contract = read_contract(self.contract_path, self.framework_root, entry_path)
        self.objects = {item['e'] for item in self.contract['entries']
                        if item['f'] == 'table_cell' and item['status'] == 'enabled'}
        sys.path.insert(0, str(self.framework_root))
        base = load_module('_circle_cell_runner', self.framework_root / 'lib/test_xlsx.py')
        if (self.contract['runtime']['minimum_version'] != base.EXCEL_FUNCTION_CONTRACT_VERSION
                or not base._contract_shape_valid(self.contract)):
            raise ValueError('独立执行器规则的版本或形状不符合原执行协议')
        self.namespace = runner_namespace(base, self.contract)

    def invoke(self, request, factory, logger, configer, check_point, db, workbook):
        runtime = self

        class Request:
            def __getattr__(self, name):
                return getattr(request, name)

            def getfixturevalue(self, name):
                value = request.getfixturevalue(name)
                return CellDevice(value) if name in runtime.objects else value

        def wrapped_factory(*args, **kwargs):
            return CellDevice(factory(*args, **kwargs))

        return self.namespace['test_xlsx'](
            Request(), wrapped_factory, logger, configer, check_point, db, str(workbook))


ACTIVE = None


def active(entry_path):
    if ACTIVE is not None:
        return ACTIVE
    settings = json.loads(Path(entry_path).with_name('cell-runtime.json').read_text(encoding='utf-8'))
    return Runtime(settings['framework_root'], Path(entry_path).with_name('excel_contract.json'), entry_path)


def run(framework_root, contract_path, workbook, pytest_args):
    global ACTIVE
    ACTIVE = Runtime(framework_root, contract_path, COMPONENT_ROOT / 'test_xlsx.py')
    fixtures = load_module('_circle_cell_fixtures',
                           Path(framework_root) / 'smoke_test/conftest.py')

    class Workbook:
        def pytest_generate_tests(self, metafunc):
            if 'xlsx_file' in metafunc.fixturenames:
                metafunc.parametrize('xlsx_file', [str(Path(workbook).resolve())],
                                     ids=[Path(workbook).name])

    import os
    import pytest
    os.chdir(framework_root)
    return pytest.main([str(COMPONENT_ROOT / 'test_xlsx.py'), '-s'] + pytest_args,
                       plugins=[fixtures, Workbook()])
