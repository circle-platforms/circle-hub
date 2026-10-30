# Show a knowledge view input in the form its parser requires

`list_task_packs` showed every external input as `{"external":"<type>:<编号>"}`. For a knowledge view that is wrong: a view id is `knowledge:<view>:<product>:<build>?<required parameters>`. Models therefore wrote ids without the required `kind`/`by`/`key` (real quality-board runs failed that way and the caller was left with a bare "unavailable").

Change: `viewIdExample(type)` in `hub/knowledge/views.ts` builds the form from the same table the parser enforces (view, product and build placeholders, required parameters); `bindingExample` in `hub/server/text.ts` uses it for every `knowledge:*` input, which also corrects the example `start_run` call. No pack changes and no version bumps: the form follows the grammar for all packs.

Allowed paths: `hub/knowledge/views.ts`, `hub/knowledge/views.test.ts`, `hub/knowledge/api.ts`, `hub/server/text.ts`, `hub/server/text.test.ts`, this page.

Verification: the two new tests and the existing text and views tests; `affected-tests.py --run` against hub-redesign.
