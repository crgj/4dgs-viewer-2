import dotenv from 'dotenv';
import glm from '../src/glm-client.js';

dotenv.config();

async function main() {
  try {
    const res = await glm.simpleChat('测试：你好，GLM 5.1');
    console.log('Response:', JSON.stringify(res, null, 2));
  } catch (err) {
    console.error('GLM test failed:', err);
    process.exitCode = 2;
  }
}

main();
