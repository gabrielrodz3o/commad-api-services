import assert from "node:assert/strict";
import test from "node:test";
import { isPointInPolygon } from "../src/modules/mobile/customer/coverage.js";
import { resolveFulfillmentAt } from "../src/modules/mobile/shared/fulfillment.js";
import { isScheduleOpen } from "../src/modules/mobile/shared/schedule.js";

const at=(iso:string)=>new Date(iso);
test("delivery distingue puntos dentro y fuera de cobertura",()=>{
  const polygon=[{lat:18.4,lng:-70},{lat:18.6,lng:-70},{lat:18.6,lng:-69.8},{lat:18.4,lng:-69.8}];
  assert.equal(isPointInPolygon({lat:18.5,lng:-69.9},polygon),true);
  assert.equal(isPointInPolygon({lat:19,lng:-69.9},polygon),false);
});
test("horario refleja sucursal abierta, cerrada y cambios",()=>{
  assert.equal(isScheduleOpen({start:"09:00",end:"22:00"},at("2026-07-22T16:00:00Z")),true);
  assert.equal(isScheduleOpen({start:"09:00",end:"12:00"},at("2026-07-22T16:00:00Z")),false);
  assert.equal(isScheduleOpen({start:"12:00",end:"22:00"},at("2026-07-22T16:00:00Z")),true);
});
test("pedido inmediato usa ahora y programado respeta ventana",()=>{
  const now=at("2026-07-22T12:00:00Z");
  assert.deepEqual(resolveFulfillmentAt(null,now),{date:now,scheduled:false});
  assert.equal(resolveFulfillmentAt("2026-07-22T13:00:00Z",now).scheduled,true);
  assert.throws(()=>resolveFulfillmentAt("2026-07-22T12:10:00Z",now),(e:any)=>e.code==="INVALID_SCHEDULE");
  assert.throws(()=>resolveFulfillmentAt("2026-08-01T12:00:00Z",now),(e:any)=>e.code==="INVALID_SCHEDULE");
});
