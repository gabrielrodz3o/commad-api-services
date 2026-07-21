import { query } from '../../../db/pool.js'

export async function getMobileProducts(params:{menuId:number;catalogueId:number;locationId:number;orderTypeId:1|2|3}){
 const channels=params.orderTypeId===1?'(0)':`(0),(${params.orderTypeId})`
 return query<any>(`
 WITH page_items AS(
  SELECT cd.item_id FROM inventory.catalogue_details cd
  JOIN inventory.items i ON i.id=cd.item_id AND i.active=TRUE
  JOIN restaurant.menu_details md ON md.menu_id=$1 AND md.item_id=cd.item_id
  JOIN inventory.item_categories cat ON cat.id=cd.category_id AND cat.is_visible=TRUE AND cat.is_supply IS NOT TRUE
  WHERE cd.catalogue_id=$2 AND cd.status_id=1
 ),
 disposable_items AS(
  SELECT child_item_id,BOOL_OR(is_disposable)is_disposable FROM inventory.item_in_recipes GROUP BY child_item_id
 ),
 aggregated_materials AS(
  SELECT md.item_id parent_item_id,ch.k channel_key,ai.child_item_id,ai.total_quantity total_required_quantity,
   cd.warehouse_id root_warehouse_id,COALESCE(dm.is_disposable,FALSE)is_disposable
  FROM page_items pit
  JOIN restaurant.menu_details md ON md.menu_id=$1 AND md.item_id=pit.item_id
  JOIN inventory.catalogue_details cd ON cd.item_id=md.item_id AND cd.catalogue_id=$2
  JOIN inventory.items im ON im.id=md.item_id AND im.item_type_id IN(3,4)
  CROSS JOIN(VALUES ${channels})ch(k)
  CROSS JOIN LATERAL inventory.get_items_from_recipe_multilevel(md.item_id,1,NULLIF(ch.k,0))ai
  LEFT JOIN disposable_items dm ON dm.child_item_id=ai.child_item_id
 ),
 stock_calculation AS(
  SELECT am.*,CASE WHEN am.total_required_quantity>0 AND COALESCE(iw.balance,0)>0
   THEN FLOOR(iw.balance/NULLIF(am.total_required_quantity,0))ELSE 0 END can_make_quantity
  FROM aggregated_materials am
  LEFT JOIN LATERAL(SELECT balance FROM inventory.item_in_warehouses
   WHERE item_id=am.child_item_id AND warehouse_id=am.root_warehouse_id ORDER BY id DESC LIMIT 1)iw ON TRUE
 ),
 producible_raw AS(
  SELECT parent_item_id,
   MIN(can_make_quantity)FILTER(WHERE channel_key=0 AND NOT is_disposable)food_producible,
   MIN(can_make_quantity)FILTER(WHERE channel_key=0)all_producible,
   MIN(can_make_quantity)FILTER(WHERE channel_key<>0 AND is_disposable)channel_pack
  FROM stock_calculation GROUP BY parent_item_id
 ),
 producible_quantities AS(
  SELECT parent_item_id,LEAST(COALESCE(food_producible,all_producible,0),COALESCE(channel_pack,food_producible,all_producible,0))max_producible_quantity
  FROM producible_raw
 ),
 simple_product_stock AS(
  SELECT DISTINCT ON(iw.item_id,iw.warehouse_id)iw.item_id,iw.warehouse_id,iw.balance raw_stock
  FROM page_items pit JOIN inventory.item_in_warehouses iw ON iw.item_id=pit.item_id
  JOIN inventory.items i ON i.id=iw.item_id AND i.item_type_id NOT IN(3,4)
  ORDER BY iw.item_id,iw.warehouse_id,iw.id DESC
 )
 SELECT cd.item_id,i.name item_name,COALESCE(i.note,'')item_note,COALESCE(i.image_url,'')item_image_url,
  i.image_json,i.item_type_id,i.unit_id,i.tax_type_id,tt.name tax_type_name,cat.name category_name,
  md.menu_id,cd.category_id,cd.warehouse_id,cd.sale_price::numeric sale_price,cd.sale_price::numeric discounted_price,
  FALSE has_active_promotion,NULL::jsonb active_promotion,i.negative_sale,md.production_center_id,
  COALESCE((SELECT json_agg(json_build_object('item_id',r.child_item_id,'item_name',ch.name,'quantity',r.quantity,
   'recipe_unit_id',COALESCE(r.recipe_unit_id,ch.unit_id)))FROM inventory.item_in_recipes r JOIN inventory.items ch ON ch.id=r.child_item_id
   WHERE r.parent_item_id=i.id),'[]'::json)item_in_recipes,
  COALESCE((SELECT json_agg(json_build_object('id',st.id,'name',st.name,'location_id',st.location_id,
   'is_multiple',st.is_multiple,'is_required',st.is_required,'min_select',st.min_select,'max_select',st.max_select,'sides',sx.sides))
   FROM restaurant.side_types st JOIN(
    SELECT s.side_type_id,json_agg(json_build_object('id',s.id,'name',s.name,'item_id',s.item_id,'side_type_id',s.side_type_id,
     'price',COALESCE(s.price,0),'image_url',COALESCE(si.image_url,''),'image_json',COALESCE(si.image_json,'{}'),
     'item_name',COALESCE(si.name,''),'max_quantity',COALESCE(s.max_quantity,1),'negative_sale',COALESCE(s.negative_sale,FALSE)))sides
    FROM restaurant.menu_item_with_sides mw JOIN restaurant.sides s ON s.id=mw.side_id
    LEFT JOIN inventory.items si ON si.id=s.item_id WHERE mw.menu_id=$1 AND mw.item_id=i.id GROUP BY s.side_type_id
   )sx ON sx.side_type_id=st.id),'[]'::json)sides_categories,
  CASE WHEN i.item_type_id=3 THEN COALESCE(inventory.fn_combo_producible(cd.item_id,$2,1),0)
   WHEN i.item_type_id=4 THEN COALESCE(pq.max_producible_quantity,0)
   ELSE FLOOR(GREATEST(COALESCE(sps.raw_stock,0),0)/NULLIF(COALESCE(i.unit_quantity,1),0))END discount_warehouse_quantity
 FROM page_items pit
 JOIN inventory.catalogue_details cd ON cd.item_id=pit.item_id AND cd.catalogue_id=$2 AND cd.status_id=1
 JOIN inventory.items i ON i.id=cd.item_id
 JOIN restaurant.menu_details md ON md.menu_id=$1 AND md.item_id=cd.item_id
 LEFT JOIN finances.tax_types tt ON tt.id=i.tax_type_id
 LEFT JOIN inventory.item_categories cat ON cat.id=cd.category_id
 LEFT JOIN producible_quantities pq ON pq.parent_item_id=cd.item_id
 LEFT JOIN simple_product_stock sps ON sps.item_id=cd.item_id AND sps.warehouse_id=cd.warehouse_id
 ORDER BY i.name`,[params.menuId,params.catalogueId])
}
