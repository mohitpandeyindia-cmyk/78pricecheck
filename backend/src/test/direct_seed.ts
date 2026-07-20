import { initializeDatabase } from '../db';

async function main() {
  console.log('Initializing database schema and seeding sample data...');
  await initializeDatabase(true);
  console.log('Database seeded successfully!');
}

main().catch(err => {
  console.error('Error during direct seeding:', err);
  process.exit(1);
});
