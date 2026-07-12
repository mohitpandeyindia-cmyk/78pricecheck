import { getDb } from '../db';

async function seed() {
  const db = await getDb();
  await db.run('DELETE FROM products WHERE barcode IN ("78001", "78002")');
  
  await db.run(
    `INSERT INTO products (barcode, name, sale_price, mrp, wholesale_price, wholesale_qty)
     VALUES ("78001", "Diet Coke 330ml", 50.00, 50.00, 48.00, 6)`
  );
  
  await db.run(
    `INSERT INTO products (barcode, name, sale_price, mrp, wholesale_price, wholesale_qty)
     VALUES ("78002", "ACT 2 CRML 70g", 60.00, 60.00, NULL, NULL)`
  );

  console.log('Seeded products successfully!');
}

seed().catch(err => {
  console.error('Error seeding:', err);
});
