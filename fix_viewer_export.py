import re

with open('src/viewer/viewer-export-manager.ts', 'r') as f:
    text = f.read()

# 1. Revert visibility logic in updateSubstep
text = text.replace(
    '/* Always keep visible for detailed view */\\n                node.row.classList.remove(\'hidden\');\\n                node.row.classList.add(\'flex\');',
    'if (state === \'active\') {\\n                    node.row.classList.remove(\'hidden\');\\n                    node.row.classList.add(\'flex\');\\n                } else {\\n                    node.row.classList.remove(\'flex\');\\n                    node.row.classList.add(\'hidden\');\\n                }'
)
# Fix literal string escape issues
text = text.replace('/* Always keep visible for detailed view */\n                node.row.classList.remove(\'hidden\');\n                node.row.classList.add(\'flex\');', 
                    'if (state === \'active\') {\n                    node.row.classList.remove(\'hidden\');\n                    node.row.classList.add(\'flex\');\n                } else {\n                    node.row.classList.remove(\'flex\');\n                    node.row.classList.add(\'hidden\');\n                }')

# Revert initial class
text = text.replace('row.className = \'loading-substep rounded-lg px-3 py-2 flex flex-col gap-1\';', 'row.className = \'loading-substep rounded-lg px-3 py-2 hidden flex-col gap-1\';')

# 2. Add AbortController to saveAsSOG4
old_sog4_start = '        try {'
new_sog4_start = """        let abortController = new AbortController();
        const cancelBtn = document.getElementById('loading-cancel');
        if (cancelBtn) {
            cancelBtn.classList.remove('hidden');
            const onCancel = () => {
                abortController.abort();
                cancelBtn.classList.add('hidden');
            };
            cancelBtn.onclick = onCancel;
        }

        try {"""
text = text.replace('async saveAsSOG4() {\\n        const v = this.viewer as any;\\n        console.log("[Export] saveAsSOG4 called. LastParsed:", v.lastParsedData);\\n        if (!v.lastParsedData) {\\n            alert("No data loaded.");\\n            return;\\n        }\\n\\n        console.log(`[Export] Saving .sog4...`);\\n        try {',
                   'async saveAsSOG4() {\n        const v = this.viewer as any;\n        console.log("[Export] saveAsSOG4 called. LastParsed:", v.lastParsedData);\n        if (!v.lastParsedData) {\n            alert("No data loaded.");\n            return;\n        }\n\n        console.log(`[Export] Saving .sog4...`);\n' + new_sog4_start)

# and hide it in finally
text = text.replace('overlay?.classList.add(\'hidden\');\\n                resetSubsteps();', 'overlay?.classList.add(\'hidden\');\\n                if (cancelBtn) cancelBtn.classList.add(\'hidden\');\\n                resetSubsteps();')

# pass signal to encode
text = text.replace('progress: (pct: number, msg: string, meta?: SOG4EncodeProgressMeta) => {', 'signal: abortController.signal,\n                progress: (pct: number, msg: string, meta?: SOG4EncodeProgressMeta) => {')

# fix literal string again
text = text.replace('overlay?.classList.add(\'hidden\');\n                resetSubsteps();', 'overlay?.classList.add(\'hidden\');\n                if (cancelBtn) cancelBtn.classList.add(\'hidden\');\n                resetSubsteps();')

# 3. Handle Cancel Error
text = text.replace('catch (e: any) {', 'catch (e: any) {\n            if (e.message === "Export cancelled") {\n                console.log("[Export] SOG4 Export cancelled by user.");\n                return;\n            }')

with open('src/viewer/viewer-export-manager.ts', 'w') as f:
    f.write(text)
