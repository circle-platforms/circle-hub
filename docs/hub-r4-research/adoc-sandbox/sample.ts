// Entirely synthetic author-structured manual; no real manual is read.
export const files:Record<string,string> = {
  'manual.adoc': `= Synthetic controller manual
:cmd: demo pool add
:chapters: chapters
:reproducible:

[#pools]
== Pools

include::{chapters}/pool.adoc[]
`,
  'chapters/pool.adoc': `[#pool-add]
=== Add a pool

*{cmd}* _<name>_ _[interval]_

[cols="1,1,2",options="header",role="domain"]
|===
|Parameter |Domain |Description
|name |1-32 characters |Pool identifier
|interval |1-60 |Probe interval in seconds
|mode |on, off |Allowed modes
|===

[#pool-signature]
[listing,role="signature"]
----
demo pool set <name> {on|off}
----

[source,cli,role="example"]
----
demo pool add synthetic 5
----

* A list item
** A nested item
* Another item

. First operation
. Second operation

[NOTE]
====
Examples are reference material, never a value-domain rule.
====
`,
};
export function scaled(bytes:number):{root:string;files:Record<string,string>} {
  const unit=files['chapters/pool.adoc'];
  const parts=['= Synthetic scale manual\n:cmd: demo pool add\n:reproducible:\n\n== Commands\n\n'];
  let size=Buffer.byteLength(parts[0]);
  for(let i=0;size<bytes;i++){const part=unit.replaceAll('pool-add',`pool-add-${i}`).replaceAll('pool-signature',`pool-signature-${i}`);parts.push(part);size+=Buffer.byteLength(part);}
  const text=parts.join('');
  return {root:'scale.adoc',files:{'scale.adoc':text}};
}
