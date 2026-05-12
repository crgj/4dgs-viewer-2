import re

with open('src/utils/sog4-encoder.ts', 'r') as f:
    text = f.read()

# Update SOG4Encoder.encode to use more granular progress
new_encode_logic = """
        const createSubProgress = (start: number, end: number, label: string) => {
            return async (force?: boolean, subPct?: number) => {
                const p = subPct ?? 0;
                const overall = start + p * (end - start);
                options.progress?.(overall, `${label} ${Math.round(p * 100)}%`, { stageLabel: label, stagePct: p * 100, overallPct: overall });
                await new Promise(r => setTimeout(r, 0));
            };
        };

        const meansProgress = createSubProgress(0, 10, "Means");
        meta.means = await compressMeans(requireColumn(ply, "x"), requireColumn(ply, "y"), requireColumn(ply, "z"), "means", state, async () => await meansProgress(false, 0.5));
        await meansProgress(false, 1.0);

        const quatsProgress = createSubProgress(10, 20, "Rotations");
        let r0, r1, r2, r3;
        if (hasColumn(ply, "rot_0")) {
            r0 = requireColumn(ply, "rot_0"); r1 = requireColumn(ply, "rot_1"); r2 = requireColumn(ply, "rot_2"); r3 = requireColumn(ply, "rot_3");
        } else {
            r0 = makeFloat32(n, 1); r1 = makeFloat32(n); r2 = makeFloat32(n); r3 = makeFloat32(n);
        }
        meta.quats = await compressQuats(r0, r1, r2, r3, "quats", state, async () => await quatsProgress(false, 0.5));
        await quatsProgress(false, 1.0);
        
        const scalesProgress = createSubProgress(20, 40, "Scales & Opacity");
        meta.scales = await compressScales(requireColumn(ply, "scale_0"), requireColumn(ply, "scale_1"), requireColumn(ply, "scale_2"), "scales", iterations, state, async () => await scalesProgress(false, 0.3));
        meta.sh0 = await compressSh0Op(requireColumn(ply, "f_dc_0"), requireColumn(ply, "f_dc_1"), requireColumn(ply, "f_dc_2"), requireColumn(ply, "opacity"), "sh0", iterations, state, async () => await scalesProgress(false, 0.7));
        await scalesProgress(false, 1.0);
        
        const names = Array.from(columns.keys());
        const shKeys = names.filter((name) => name.startsWith("f_rest_"));
        if (shKeys.length > 0) {
            const shnProgress = createSubProgress(40, 75, "SHN");
            meta.shN = await compressShN(collectShData(ply, shKeys), n, shKeys.length, iterations, state, seed, 1, shnProgress);
            await shnProgress(false, 1.0);
        }

        if (hasColumn(ply, "lifetime_mu")) {
            const paramsProgress = createSubProgress(75, 80, "Params");
            meta.params = await compressParams(requireColumn(ply, "lifetime_mu"), requireColumn(ply, "lifetime_w"), hasColumn(ply, "is_param") ? requireColumn(ply, "is_param") : makeFloat32(n), iterations, state, paramsProgress);
            await paramsProgress(false, 1.0);
        }
        
        const zip = new JSZip();
        const webpProgress = createSubProgress(80, 95, "WebP Compress");
        await addWebpFiles(zip, state, 1, async () => await webpProgress(false, 0.5));
        await webpProgress(false, 1.0);
        
        zip.file("meta.json", JSON.stringify(meta, null, 2), { compression: "STORE" });
        const zipProgress = createSubProgress(95, 100, "Zip Generation");
        await zipProgress(false, 0.1);
        const content = await zip.generateAsync({ type: "uint8array", compression: "STORE" });
        await zipProgress(false, 1.0);
        return content;
"""

# Find the block from `const scheduler` to `return content`
text = re.sub(r'const scheduler = .*?return content;', new_encode_logic, text, flags=re.DOTALL)

# Fix loop granularities in helpers to report progress if possible
# meansProgress: every 50k points is too much or too little? 50k is fine.
# But I should pass subPct to the scheduler if possible.

with open('src/utils/sog4-encoder.ts', 'w') as f:
    f.write(text)
