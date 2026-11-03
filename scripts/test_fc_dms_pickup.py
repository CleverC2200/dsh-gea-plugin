"""Exercise the shipped SQL's code/name validation without network or credentials."""
import re,sqlite3,unittest
from pathlib import Path
source=(Path(__file__).resolve().parents[1]/'src/host/fc-dms-target.ts').read_text()
SQL=re.search(r'FC_DMS_DEFAULT_PICKUP_SQL = `([\s\S]*?)`;',source).group(1)
class Pickup(unittest.TestCase):
 def resolve(self,links,master=None):
  with sqlite3.connect(':memory:') as db:
   db.execute('CREATE TABLE agents_dim_dealer_data_d (cust_code TEXT,pickup_point_code TEXT,pickup_point_name TEXT)')
   db.execute('CREATE TABLE agents_dim_pickup_point_data_d (pickup_point_code TEXT,pickup_point_name TEXT)')
   db.executemany('INSERT INTO agents_dim_dealer_data_d VALUES (?,?,?)',[('C1',*x) for x in links])
   db.executemany('INSERT INTO agents_dim_pickup_point_data_d VALUES (?,?)',master or [('02','华东'),('37','遂平')])
   return db.execute(SQL,{'gea_p1':'C1'}).fetchone()[0]
 def test_normal_and_swapped_pairs_resolve_only_against_master(self):
  self.assertEqual(self.resolve([('02','华东')]),'02')
  self.assertEqual(self.resolve([('遂平','37')]),'37')
 def test_duplicate_sku_master_rows_do_not_create_ambiguity(self):
  self.assertEqual(self.resolve([('02','华东'),('02','华东')],[('02','华东'),('02','华东')]),'02')
 def test_two_codes_or_incomplete_relations_remain_unknown(self):
  self.assertIsNone(self.resolve([('02','华东'),('37','遂平')]))
  self.assertIsNone(self.resolve([('02','华东'),('bad','37')]))
  self.assertIsNone(self.resolve([('02',None)]))
 def test_wrong_pair_and_no_relation_are_not_guessed(self):
  self.assertIsNone(self.resolve([('02','遂平')]))
  self.assertIsNone(self.resolve([]))
if __name__=='__main__':unittest.main()
