const fs = require('fs');
const { execSync } = require('child_process');

function syncEnv(dir, service) {
    if (!fs.existsSync(dir + '/.env')) {
        console.log(`No .env found in ${dir}`);
        return;
    }
    const env = fs.readFileSync(dir + '/.env', 'utf8');
    const lines = env.split('\n');
    for (const line of lines) {
        if (!line.trim() || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.substring(0, eq).trim();
        let val = line.substring(eq + 1).trim();
        // Remove quotes if present
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.substring(1, val.length - 1);
        }
        
        console.log(`Setting ${key} for ${service}...`);
        try {
            execSync(`railway variable set "${key}=${val}" -s "${service}"`, { stdio: 'ignore', cwd: dir });
        } catch (e) {
            console.log(`Failed to set ${key}`);
        }
    }
    // Also explicitly set SHADOW_MODE and DRY_RUN_MODE
    execSync(`railway variable set "SHADOW_MODE=true" -s "${service}"`, { stdio: 'ignore', cwd: dir });
    if (service === 'nexus-quant-solana') {
        execSync(`railway variable set "DRY_RUN_MODE=true" -s "${service}"`, { stdio: 'ignore', cwd: dir });
    }
    console.log(`Finished sync for ${service}`);
}

syncEnv('D:/Programas/Desenvolvendo/nexus-quant-solana', 'nexus-quant-solana');
syncEnv('D:/Programas/Desenvolvendo/nexus-pump-sentinel', 'nexus-pump-sentinel');
