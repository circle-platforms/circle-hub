# @infosec/assessor

语义判断的可替换接口与 P2 默认实现（ADR 0013）。`ScriptedAssessor` 是确定性规则判断（无证据→insufficient-evidence；证据互相矛盾→abstained；证据值与主张值一致→supports；不一致→refutes），不设 confidence、不冒充模型——它的通过只证明管线与记录形态正确，不构成任何模型质量结论。真实模型接入时以同接口实现并另行 ADR 记录模型与版本。

本地验证：`npm install && npm run typecheck && npm test`。
