/** The sole fixed SELECT used by the sales page's workflow configuration reader. */
export const WORKFLOW_CONFIG_SQL =
  "SELECT id, type_code, examine_level, node_num FROM agents_scm_plan_workflow_config WHERE status = :active AND delete_status = :notDeleted ORDER BY type_code, examine_level, id";
export const WORKFLOW_PAGE_SIZE = 100;
