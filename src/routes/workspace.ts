import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { locationFields,normalizeLocationIds,resolveTenant } from '../lib/resolve.js'
import { assertBusinessAccess } from '../db/business-access.js'
import { generateJSON } from '../llm/provider.js'

// The core supplies validated data and schemas. This route performs no business writes.
const Body=z.object({
  ...locationFields,
  system:z.string().min(1).max(16000),user:z.string().min(1).max(180000),
  schema:z.record(z.any()).refine(v=>JSON.stringify(v).length<=30000),
  schema_name:z.enum(['comandi_plan','comandi_analysis']),max_tokens:z.number().int().min(1).max(4500),
  permission_screens:z.array(z.enum(['reports','crm','inventories','requisiciones'])).min(1).max(4),
})
export function workspaceRoutes(app:FastifyInstance){
  app.post('/comandi/workspace/reason',async(req,reply)=>{
    if(req.actor?.type!=='user')return reply.code(401).send({success:false,message:'Sesión de usuario requerida'})
    const parsed=Body.safeParse(req.body)
    if(!parsed.success)return reply.code(400).send({success:false,message:'Consulta estructurada inválida'})
    const body=parsed.data,ids=normalizeLocationIds(body)
    const {businessUnitId,config}=await resolveTenant(body,req.actor)
    for(const screen of body.permission_screens)await assertBusinessAccess(req.actor.userId,businessUnitId,ids,screen)
    if(!config)return {enabled:false}
    const result=await generateJSON({config,system:body.system,user:body.user,schema:body.schema,schemaName:body.schema_name,maxTokens:body.max_tokens,
      usageMeta:{businessUnitId,userId:req.actor.userId,endpoint:body.schema_name==='comandi_plan'?'workspace-plan':'workspace-analysis'}})
    return {enabled:true,result}
  })
}
