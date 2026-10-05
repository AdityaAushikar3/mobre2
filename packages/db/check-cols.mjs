import pg from 'pg';
const { Client } = pg;
const client = new Client({ connectionString: 'postgresql://postgres:postgres@localhost:5432/classroomio' });

async function run() {
  await client.connect();

  // Just query the columns
  const cols = await client.query(
    `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'organization'`
  );
  console.log('Org columns:', cols.rows);

  const userCols = await client.query(
    `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'user'`
  );
  console.log('User columns:', userCols.rows);

  const courseCols = await client.query(
    `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'course'`
  );
  console.log('Course columns:', courseCols.rows);

  await client.end();
}
run().catch(console.error);
