import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import { workspaceRoutes, workspaceScreens } from '../src/routes/workspace.js'
import type { Actor } from '../src/plugins/auth.js'

const body={business_unit_id:33,active_location_id:33,location_ids:[33],
  system:'Consulta solo la evidencia autorizada.',user:JSON.stringify({question:'Verifica GUI-00186 del 28/10/2026'}),
  schema:{type:'object',additionalProperties:false,properties:{answer:{type:'string'}},required:['answer']},
  schema_name:'comandi_analysis',max_tokens:4000,permission_screens:[...workspaceScreens]}

async function fixture(options:{actor?:Actor|null;denied?:string;revoked?:boolean;disabled?:boolean;wrongTenant?:boolean;modelFails?:boolean}={}){
  const app=Fastify()
  const checks:string[]=[]
  const calls:unknown[]=[]
  app.addHook('onRequest',async req=>{req.actor=options.actor===null?undefined:options.actor || {type:'user',userId:770}})
  workspaceRoutes(app,{
    resolveTenant:async()=>{
      if(options.wrongTenant)throw Object.assign(new Error('Empresa no autorizada'),{statusCode:403})
      return {businessUnitId:33,config:options.disabled?null:{businessUnitId:33,provider:'openai',model:'test',apiKey:'unused'}}
    },
    assertBusinessAccess:async(userId,businessUnitId,ids,screen)=>{
      assert.equal(userId,770);assert.equal(businessUnitId,33);assert.deepEqual(ids,[33])
      checks.push(screen)
      if(screen===options.denied || (options.revoked && calls.length))throw Object.assign(new Error('Permiso denegado'),{statusCode:403})
    },
    generateJSON:async<T>(opts:unknown):Promise<T>=>{
      calls.push(opts)
      if(options.modelFails)throw Object.assign(new Error('Motor no disponible'),{statusCode:502})
      return {answer:'✅ GUI-00186: salida de 132 lb y entrada de 132 lb.'} as T
    },
  })
  const send=(payload:unknown=body)=>app.inject({method:'POST',url:'/comandi/workspace/reason',payload})
  return {app,send,checks,calls}
}

test('acepta los permisos de cada pantalla del ERP y conserva evidencia/esquema',async t=>{
  const f=await fixture();t.after(()=>f.app.close())
  const response=await f.send()
  assert.equal(response.statusCode,200)
  assert.equal(response.json().enabled,true)
  assert.match(response.json().result.answer,/132 lb/)
  assert.deepEqual(f.checks,[...['comandi',...workspaceScreens],...['comandi',...workspaceScreens]])
  assert.deepEqual(f.calls,[{config:{businessUnitId:33,provider:'openai',model:'test',apiKey:'unused'},
    system:body.system,user:body.user,schema:body.schema,schemaName:body.schema_name,maxTokens:4000,
    usageMeta:{businessUnitId:33,userId:770,endpoint:'workspace-analysis'}}])
})
test('planificación acepta movement solo y registra la fase correcta',async t=>{
  const f=await fixture();t.after(()=>f.app.close())
  assert.equal((await f.send({...body,schema_name:'comandi_plan',permission_screens:['movement']})).statusCode,200)
  assert.deepEqual(f.checks,['comandi','movement','comandi','movement'])
  assert.equal((f.calls[0] as {usageMeta:{endpoint:string}}).usageMeta.endpoint,'workspace-plan')
})
for(const denied of ['comandi',...workspaceScreens])test(`rechaza permiso ${denied} denegado antes de llamar al modelo`,async t=>{
  const f=await fixture({denied});t.after(()=>f.app.close())
  assert.equal((await f.send()).statusCode,403);assert.equal(f.calls.length,0)
})
for(const actor of [null,{type:'service'} as const])test(`rechaza identidad ${actor?.type || 'ausente'}`,async t=>{
  const f=await fixture({actor});t.after(()=>f.app.close())
  assert.equal((await f.send()).statusCode,401);assert.equal(f.calls.length,0)
})
test('no entrega respuestas después de revocar el acceso',async t=>{
  const f=await fixture({revoked:true});t.after(()=>f.app.close())
  const response=await f.send();assert.equal(response.statusCode,403)
  assert.equal(response.json().result,undefined);assert.equal(f.calls.length,1)
})
test('empresa incorrecta no llega al modelo',async t=>{
  const f=await fixture({wrongTenant:true});t.after(()=>f.app.close())
  assert.equal((await f.send()).statusCode,403);assert.equal(f.calls.length,0)
})
test('IA deshabilitada no consume una llamada',async t=>{
  const f=await fixture({disabled:true});t.after(()=>f.app.close())
  assert.deepEqual((await f.send()).json(),{enabled:false});assert.equal(f.calls.length,0)
})
test('un fallo del motor no se convierte en éxito',async t=>{
  const f=await fixture({modelFails:true});t.after(()=>f.app.close())
  assert.equal((await f.send()).statusCode,502)
})
test('rechaza alcance incompleto, permisos desconocidos y esquemas sobredimensionados',async t=>{
  const f=await fixture();t.after(()=>f.app.close())
  for(const invalid of [
    {...body,business_unit_id:undefined},{...body,active_location_id:undefined},
    {...body,location_ids:[]},{...body,location_ids:Array(101).fill(33)},
    {...body,permission_screens:['admin']},{...body,permission_screens:[]},
    {...body,schema:{description:'x'.repeat(30001)}},
  ])assert.equal((await f.send(invalid)).statusCode,400)
  assert.equal(f.calls.length,0)
})
