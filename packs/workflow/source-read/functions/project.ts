// Projection function of the generic source-read skill pack (ProjectionInput -> ProjectionOutput).
// This pack reads platform original artifacts without binding any product line.
// It declares zero requirements: this projection only checks that a source was bound. The Hub
// separately reports the original references and any asynchronous feeding progress or missing facts.

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface PackWarning {
  code: string;
  message: string;
}

export interface PackFailure {
  error: {
    code: string;
    message: string;
    fix: string;
  };
  warnings: PackWarning[];
}

export interface ProjectionSuccess {
  items: unknown[];
  groups?: unknown[];
  warnings: PackWarning[];
}

export type ProjectionResult = ProjectionSuccess | PackFailure;

export default function project(input: unknown): ProjectionResult {
  const params = isRecord(input) ? input : {};
  const inputs = Array.isArray(params.inputs) ? params.inputs : [];
  if (inputs.length === 0) {
    return {
      error: {
        code: 'source-read.no_source',
        message: '未提供任何要读取的外部来源',
        fix: '在 inputs 里至少提供一个来源（defect、story、build、mindmap、build_page、manual_file、svn_file）',
      },
      warnings: [],
    };
  }
  return {
    items: [],
    groups: [],
    warnings: [],
  };
}
