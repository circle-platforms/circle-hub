"""Select one text cell from an explicitly declared table shape."""


class CellSelectionError(ValueError):
    pass


PARAMETER_ROLES = {
    'output': 'cell_source',
    'conditions': 'cell_selection',
    'separator': 'cell_selection',
    'columns': 'cell_selection',
    'column': 'cell_selection',
    'format': 'cell_selection',
    'header': 'cell_selection',
    'row': 'cell_selection',
}
PARAMETER_TYPES = {
    'output': 'string', 'conditions': 'string', 'separator': 'string',
    'columns': 'int', 'column': 'int', 'format': 'string',
    'header': 'int', 'row': 'int',
}
# Exported rule data, not a runtime fallback: Runtime binds the validated entry.
CELL_VALUE_POLICY = {
    'schema': 'ascii-cell-value@1',
    'characters': 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._+:-',
    'min_length': 1,
    'max_length': 255,
}
CELL_EFFECT = {'roles': ['cell_source', 'cell_selection'], 'budget': 256,
               'device_calls': False, 'value_policy': CELL_VALUE_POLICY}


def checked_value_policy(policy):
    if not isinstance(policy, dict) or set(policy) != {'schema', 'characters', 'min_length', 'max_length'} or policy['schema'] != 'ascii-cell-value@1':
        raise CellSelectionError('取不到：取格方法缺少完整的值策略声明；位置：执行器规则')
    chars = policy['characters']
    minimum, maximum = policy['min_length'], policy['max_length']
    if (not isinstance(chars, str) or not chars or len(set(chars)) != len(chars)
            or any(not 33 <= ord(char) <= 126 for char in chars)
            or type(minimum) is not int or type(maximum) is not int
            or minimum < 1 or maximum < minimum):
        raise CellSelectionError('取不到：取格值策略不符合ASCII字符集合与长度声明；位置：执行器规则')
    return dict(policy)


def checked_cell_value(value, policy):
    rule = checked_value_policy(policy)
    if not isinstance(value, str):
        raise CellSelectionError('取不到：取格值不是文字；位置：取值列')
    if not rule['min_length'] <= len(value) <= rule['max_length']:
        raise CellSelectionError('取不到：取格值长度不在规则声明的%d到%d之间；位置：取值列' % (rule['min_length'], rule['max_length']))
    for index, char in enumerate(value, 1):
        if char in rule['characters']:
            continue
        if ord(char) < 32 or ord(char) == 127:
            kind = '控制字符'
        elif char.isspace():
            kind = '空白字符'
        elif ord(char) > 127:
            kind = '非ASCII字符'
        elif char in ('\"', "'"):
            kind = '引号字符'
        else:
            kind = '非允许符号'
        raise CellSelectionError('取不到：取格值含%s U+%04X；位置：取值列字符%d' % (kind, ord(char), index))
    return value


def table_cell(output, *conditions, separator, columns, column,
               format='delimited', header=0, row=0, value_policy=None) -> str:
    def fail(position, reason):
        raise CellSelectionError('取不到：%s；位置：%s\n设备原话：\n%s' % (
            reason, position, output))

    if not isinstance(output, str):
        fail('输入', '保存的设备输出不是文字')
    if type(columns) is not int or columns < 1:
        fail('列数', '列数必须是正整数')
    if not isinstance(separator, str) or header not in (0, 1):
        fail('表格声明', '分隔符或表头声明不正确')
    if type(row) is not int or row < 0 or bool(row) == bool(conditions):
        fail('选行', '行序号和等值条件必须二选一')
    if format not in ('delimited', 'key_value'):
        fail('表格声明', '不认识该表格形状')
    if format == 'key_value' and (not separator or columns != 2):
        fail('表格声明', '键值行需要分隔符及两列')
    if not separator and columns != 1:
        fail('表格声明', '没有分隔符时只能声明一列')

    rows = []
    for number, line in enumerate(output.splitlines(), 1):
        if not line.strip():
            continue
        if format == 'key_value':
            if separator not in line:
                continue
            cells = line.split(separator, 1)
        else:
            cells = line.split(separator) if separator else [line]
            if len(cells) != columns:
                continue
        rows.append((number, cells))
    if not rows:
        fail('数据行', '没有符合声明形状的行')
    if header:
        rows.pop(0)
    if type(column) is not int or not 1 <= column <= columns:
        fail('取列', '指定列不存在')
    picked_column = column - 1

    matches = []
    for index, condition in enumerate(conditions, 1):
        if not isinstance(condition, str) or not condition.startswith('where '):
            fail('条件%d' % index, '条件须写成 where 第几列=常量')
        left, equal, value = condition[6:].partition('=')
        if not equal or not left or not all('0' <= char <= '9' for char in left):
            fail('条件%d' % index, '条件列序号不正确')
        position = int(left)
        if not 1 <= position <= columns:
            fail('条件%d/第%d列' % (index, position), '条件列不存在')
        matches.append((position - 1, value))
    selected = rows[row - 1:row] if row else [
        item for item in rows
        if all(item[1][position] == value for position, value in matches)
    ]
    if len(selected) != 1:
        fail('数据行%d' % row if row else '等值条件',
             '选中%d行，必须恰好一行' % len(selected))
    return checked_cell_value(selected[0][1][picked_column], value_policy)
