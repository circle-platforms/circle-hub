"""Private per-call pytest entry; the shared runner file is never changed."""

import sys
import json
from pathlib import Path

settings_file = Path(__file__).with_name('cell-runtime.json')
if settings_file.exists():
    settings = json.loads(settings_file.read_text(encoding='utf-8'))
    sys.path.insert(0, settings['component_root'])

import cell_runtime


def pytest_generate_tests(metafunc):
    if settings_file.exists() and 'xlsx_file' in metafunc.fixturenames:
        workbook = Path(__file__).with_name('case.xlsx')
        metafunc.parametrize('xlsx_file', [str(workbook)], ids=[workbook.name])


def test_xlsx(request, apv_xlsx, logger, configer, check_point, db, xlsx_file):
    return cell_runtime.active(__file__).invoke(
        request, apv_xlsx, logger, configer, check_point, db, xlsx_file)
