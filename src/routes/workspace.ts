import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { normalizeLocationIds,resolveTenant } from '../lib/resolve.js'
import { assertBusinessAccess } from '../db/business-access.js'
import { generateJSON } from '../llm/provider.js'

// The core supplies validated data and schemas. This route performs no business writes.
export const workspaceScreens = ['reports','crm','inventories','requisiciones','movement','adjustment','kardex','receipts','production','waste','requisitions','requisitions_received'] as const
export const workspaceBody=z.object({
  business_unit_id:z.number().int().positive(),
  active_location_id:z.number().int().positive(),
  location_ids:z.array(z.number().int().positive()).min(1).max(100),
  system:z.string().min(1).max(16000),user:z.string().min(1).max(180000),
  schema:z.record(z.any()).refine(v=>JSON.stringify(v).length<=30000),
  schema_name:z.enum(['comandi_plan','comandi_analysis']),max_tokens:z.number().int().min(1).max(4500),
  permission_screens:z.array(z.enum(workspaceScreens)).min(1).max(workspaceScreens.length),
})
// Injectable boundaries keep HTTP contract and authorization tests independent of DB/LLM.
const dependencies={resolveTenant,assertBusinessAccess,generateJSON}
export function workspaceRoutes(app:FastifyInstance,deps=dependencies){
  app.post('/comandi/workspace/reason',async(req,reply)=>{
    if(req.actor?.type!=='user')return reply.code(401).send({success:false,message:'Sesión de usuario requerida'})
    const parsed=workspaceBody.safeParse(req.body)
    if(!parsed.success)return reply.code(400).send({success:false,message:'Consulta estructurada inválida'})
    const body=parsed.data,ids=normalizeLocationIds(body)
    const {businessUnitId,config}=await deps.resolveTenant(body,req.actor)
    const userId=req.actor.userId
    const screens=['comandi',...new Set(body.permission_screens)]
    const checkAccess=async()=>{
      for(const screen of screens)await deps.assertBusinessAccess(userId,businessUnitId,ids,screen)
    }
    await checkAccess()
    if(!config)return {enabled:false}
    const result=await deps.generateJSON({config,system:body.system,user:body.user,schema:body.schema,schemaName:body.schema_name,maxTokens:body.max_tokens,
      usageMeta:{businessUnitId,userId,endpoint:body.schema_name==='comandi_plan'?'workspace-plan':'workspace-analysis'}})
    // A revoked permission must also apply to an in-flight model response.
    await checkAccess()
    return {enabled:true,result}
  })
}
