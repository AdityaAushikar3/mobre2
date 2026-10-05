import pg from 'pg';
import fs from 'fs';

const { Client } = pg;
const client = new Client({
  connectionString: 'postgresql://postgres:postgres@localhost:5432/classroomio'
});

async function run() {
  await client.connect();
  const sql = fs.readFileSync('src/migrations/0027_acoustic_praxagora.sql', 'utf-8');
  const statements = sql.split('--> statement-breakpoint');
  for (const statement of statements) {
    if (statement.trim()) {
      await client.query(statement);
    }
  }
  await client.end();
}

run().catch(console.error);
