WITH warehouses AS (
 SELECT b.warehouseid AS warehouseid,MAX(b.warehouse_name) AS warehouse_name,MAX(b.belong_base) AS belong_base
 FROM agents_inv_branch_sku_day b WHERE b.inv_batch_id=@inv_batch_id AND b.inv_variant_id='BRANCH_WAREHOUSE_DIRECTORY'
 GROUP BY b.warehouseid HAVING COUNT(DISTINCT b.warehouse_name)=1
), execution_keys AS (
 SELECT e.receive_wh AS warehouseid,MAX(e.header_addtime) AS latest_at
 FROM agents_scm_execute_detail_d e INNER JOIN warehouses w ON e.receive_wh=w.warehouseid
 WHERE NULLIF(TRIM(e.cust_code),'') IS NOT NULL AND e.header_addtime<=@inv_source_cutoff
 GROUP BY e.receive_wh
), execution_customers AS (
 SELECT e.receive_wh AS warehouseid,CASE WHEN COUNT(DISTINCT TRIM(e.cust_code))=1 THEN MAX(TRIM(e.cust_code)) ELSE NULL END AS customer_code
 FROM agents_scm_execute_detail_d e INNER JOIN execution_keys k ON e.receive_wh=k.warehouseid AND e.header_addtime=k.latest_at
 GROUP BY e.receive_wh
), customers AS (
 SELECT w.warehouseid AS warehouseid,MAX(w.warehouse_name) AS warehouse_name,MAX(w.belong_base) AS belong_base,
 CASE WHEN COUNT(DISTINCT d.cust_code)=1 THEN MAX(d.cust_code) ELSE NULL END AS customer_code,
 CASE WHEN COUNT(DISTINCT d.cust_code)=1 AND COUNT(DISTINCT d.dealer_receive_addr)=1 THEN MAX(d.dealer_receive_addr) ELSE NULL END AS receive_addresses
 FROM warehouses w LEFT JOIN execution_customers e ON w.warehouseid=e.warehouseid
 LEFT JOIN agents_dim_dealer_data_d d ON (e.warehouseid IS NOT NULL AND d.cust_code=e.customer_code) OR (e.warehouseid IS NULL AND TRIM(d.cust_name)=TRIM(w.warehouse_name))
 GROUP BY w.warehouseid
), pickup_master AS (
 SELECT pickup_point_code AS pup_code,pickup_point_name AS pup_name FROM agents_dim_pickup_point_data_d GROUP BY pickup_point_code,pickup_point_name
), customer_pickup_links AS (
 SELECT d.cust_code AS customer_code,d.pickup_point_code AS source_code,d.pickup_point_name AS source_name
 FROM agents_dim_dealer_data_d d INNER JOIN customers c ON d.cust_code=c.customer_code
 GROUP BY d.cust_code,d.pickup_point_code,d.pickup_point_name
), pickups AS (
 SELECT d.customer_code AS customer_code,CASE WHEN COUNT(*)=COUNT(p.pup_code) AND COUNT(DISTINCT p.pup_code)=1 THEN MAX(p.pup_code) ELSE NULL END AS pup_code
 FROM customer_pickup_links d LEFT JOIN pickup_master p ON
 (TRIM(d.source_code)=TRIM(p.pup_code) AND TRIM(d.source_name)=TRIM(p.pup_name)) OR
 (TRIM(d.source_name)=TRIM(p.pup_code) AND TRIM(d.source_code)=TRIM(p.pup_name))
 GROUP BY d.customer_code
), addresses AS (
 SELECT c.warehouseid AS warehouseid,c.warehouse_name AS warehouse_name,c.belong_base AS belong_base,c.customer_code AS customer_code,
 NULLIF(TRIM(get_json_string(a.addr,'$.cust_code')),'') AS address_code,
 CONCAT_WS(' · ',NULLIF(TRIM(get_json_string(a.addr,'$.cust_name')),''),NULLIF(TRIM(get_json_string(a.addr,'$.address')),'')) AS address_name
 FROM customers c
 LATERAL VIEW explode_json_array_json_outer(c.receive_addresses) a AS addr
)
SELECT a.warehouseid AS warehouseid,MAX(a.warehouse_name) AS warehouse_name,MAX(a.belong_base) AS belong_base,
 MAX(a.customer_code) AS dms_customer_code,a.address_code AS dms_address_code,
 MAX(p.pup_code) AS dms_pickup_point_code,MAX(a.address_name) AS dms_address_name
FROM addresses a LEFT JOIN pickups p ON a.customer_code=p.customer_code GROUP BY a.warehouseid,a.address_code