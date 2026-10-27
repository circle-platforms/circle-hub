// Inspect lock call sites without executing migrations or assuming one package's private constants.
import assert from 'node:assert/strict';
import {readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import ts from 'typescript';

test('every records advisory lock uses a named namespace distinct from all other locks',()=>{
  const locks=new Map<string,number>(),unnamed:string[]=[];
  const visitDirectory=(directory:string)=>{
    for(const file of readdirSync(directory,{withFileTypes:true})){
      const path=join(directory,file.name);
      if(file.isDirectory()){visitDirectory(path);continue;}
      if(!file.name.endsWith('.ts')||file.name.endsWith('.test.ts'))continue;
      const source=ts.createSourceFile(path,readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true),constants=new Map<string,number>();
      const definitions=(node:ts.Node)=>{
        if(ts.isVariableDeclaration(node)&&ts.isIdentifier(node.name)&&node.initializer&&ts.isNumericLiteral(node.initializer))constants.set(node.name.text,Number(node.initializer.text.replaceAll('_','')));
        ts.forEachChild(node,definitions);
      };definitions(source);
      const calls=(node:ts.Node)=>{
        if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='query'){
          const sql=node.arguments[0];
          if(sql&&(ts.isStringLiteral(sql)||ts.isNoSubstitutionTemplateLiteral(sql))&&(sql.text.includes('pg_advisory_xact_lock(')||sql.text.includes('pg_try_advisory_lock('))){
            const args=node.arguments[1];assert.ok(args&&ts.isArrayLiteralExpression(args),'lock arguments must be statically inspectable');
            const space=args.elements[0];assert.ok(space);
            const name=ts.isIdentifier(space)?space.text:space.getText(source);
            const value=ts.isNumericLiteral(space)?Number(space.text.replaceAll('_','')):constants.get(name);
            assert.ok(value!==undefined&&Number.isSafeInteger(value),'the namespace must be a named numeric constant');
            if(!ts.isIdentifier(space))unnamed.push(file.name+':'+name);
            locks.set(path+':'+name,value);
          }
        }
        ts.forEachChild(node,calls);
      };calls(source);
    }
  };visitDirectory(fileURLToPath(new URL('.',import.meta.url)));
  assert.ok(locks.size>=7,'the scan covers both one-key locks and every two-key namespace');
  assert.equal(new Set(locks.values()).size,locks.size,'advisory lock namespaces must not collide');
  assert.deepEqual(unnamed,[],'lock namespaces use dedicated named constants');
});
