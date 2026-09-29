// --- CONFIGURATION ---
// If empty, it attempts to use the current page's origin (good for "Host It There" method)
let API_BASE = ""; 

// --- VISUALIZATION SETUP ---
const ROUTER_NODE_SIZE = 15;
const END_DEVICE_NODE_SIZE = 15;

const nodes = new vis.DataSet([]);
const edges = new vis.DataSet([]);
const container = document.getElementById('mynetwork');
const data = { nodes: nodes, edges: edges };
const options = {
    nodes: {
        shape: 'hexagon',
        size: ROUTER_NODE_SIZE,
        font: { size: 14, face: 'monospace', background: 'transparent' },
        borderWidth: 2,
        shadow: true
    },
    edges: {
        width: 2,
        smooth: false,
        font: { align: 'top', size: 10, background: 'transparent', strokeWidth: 0 }
    },
    physics: {
        stabilization: false,
        barnesHut: { 
            gravitationalConstant: -10000, 
            springConstant: 0.04, 
            springLength: 100,
            damping: 0.09
        }
    }
};
const network = new vis.Network(container, data, options);

// --- EVENT LISTENERS ---
document.getElementById('btnStart').addEventListener('click', startDiscovery);
document.getElementById('btnExport').addEventListener('click', exportData);
// Import Logic
const modal = document.getElementById('importModal');
document.getElementById('btnImport').addEventListener('click', () => modal.style.display = 'flex');
document.getElementById('btnCancelImport').addEventListener('click', () => modal.style.display = 'none');
document.getElementById('btnParseImport').addEventListener('click', parseCliInput);

// Add listener for Link Filter
document.getElementById('linkFilter').addEventListener('change', updateLinkVisibility);

// --- STATE ---
const visitedNodes = new Set();
const nodeQueue = [];
let isScanning = false;
let currentLeaderId = null;

// Manual Name Mapping: { "ext_address_hex": "Friendly Name" }
let deviceNames = {
    "b2c9a2836317bc63": "Border Router",
    // Add your devices here, e.g.:
    // "f4ce36...": "Living Room Light"
};

// Try to load external names file if valid
fetch('device_names.json')
    .then(r => r.json())
    .then(data => { deviceNames = { ...deviceNames, ...data }; })
    .catch(e => console.log("No external device_names.json found, using defaults."));

// --- CLICK INTERACTION ---
network.on("click", function (params) {
    if (params.nodes.length > 0) {
        const nodeId = params.nodes[0];
        const node = nodes.get(nodeId);
        
        let ip6Html = '';
        if (node.rawData && node.rawData.ip6 && Array.isArray(node.rawData.ip6)) {
            ip6Html = '<strong>IPv6 Addresses:</strong><br><div style="font-size:10px; margin-left:10px;">' + 
                      node.rawData.ip6.join('<br>') + '</div><br>';
        }

        const extAddr = (node.rawData && node.rawData.extAddress) ? node.rawData.extAddress : (node.title ? node.title.split('\n')[0] : 'Unknown');

        const detailHtml = `
            <strong>RLOC16:</strong> ${node.id}<br>
            <strong>Extended Address:</strong> <br>${extAddr}<br>
            ${ip6Html}
            <strong>Role:</strong> ${node.group}<br>
            <strong>Raw Info:</strong> <pre style="font-size:10px">${JSON.stringify(node.rawData, null, 2)}</pre>
        `;
        document.getElementById('details-panel').innerHTML = detailHtml;
    }
});

// --- LOGGING ---
function log(msg) {
    const win = document.getElementById('log-window');
    const time = new Date().toLocaleTimeString().split(' ')[0];
    win.innerHTML += `<div class="log-entry"><span class="log-time">[${time}]</span> ${msg}</div>`;
    win.scrollTop = win.scrollHeight;
}

// Recursively converts object keys to camelCase (lowercases the first character),
// so PascalCase responses (e.g. "ExtAddress") are handled like camelCase ones.
function normalizeKeys(value) {
    if (Array.isArray(value)) return value.map(normalizeKeys);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k.charAt(0).toLowerCase() + k.slice(1)] = normalizeKeys(v);
        }
        return out;
    }
    return value;
}

// --- UPDATED DISCOVERY ENGINE ---
async function startDiscovery() {
    // Set API URL from input if provided
    const inputUrl = document.getElementById('apiUrl').value;
    if (inputUrl) {
        API_BASE = inputUrl.replace(/\/$/, ""); 
    } else if (!API_BASE) {
        // Default to the known OTBR address if input is empty and no base set
        API_BASE = "http://192.168.1.50:8081";
        log(`No URL provided. Using default: ${API_BASE}`);
    }

    if (isScanning) return;
    isScanning = true;
    document.getElementById('btnStart').disabled = true;
    
    nodes.clear();
    edges.clear();
    visitedNodes.clear();
    nodeQueue.length = 0;

    log("Starting discovery...");

    try {
        // Step 1: Get Local Node (Border Router)
        const selfResp = await fetch(`${API_BASE}/node`, {
            headers: { 'Accept': 'application/json' }
        });
        if (!selfResp.ok) throw new Error(`HTTP Error: ${selfResp.status}`);
        
        const selfData = normalizeKeys(await selfResp.json());
        
        // --- FIX IS HERE: Handle Flat vs Wrapped JSON ---
        // If 'result' exists, use it. Otherwise, use the root object.
        const rootData = selfData.result ? selfData.result : selfData; 
        
        // Capture Leader ID from local node data
        if (rootData.leaderData) {
            currentLeaderId = rootData.leaderData.leaderRouterId;
            log(`Network Leader Router ID: ${currentLeaderId}`);
        }

        const startRloc = rootData.rloc16;
        // FIX: If rootData.extAddress is missing in /node (sometimes it is), try to fetch /api/diagnostics/ for self first
        // But usually /node has it. If not, use 'undefined' which triggers fallback logic.
        const startExt = rootData.extAddress; 

        if (!startRloc) {
                throw new Error("Could not find RLOC16 in API response. Check console.");
        }
        
        log(`Border Router found at ${startRloc} (${startExt || 'Unknown Ext'})`);
        
        // Add BR to map
        addNodeToGraph(startRloc, { ...rootData, extAddress: startExt }, "Border Router");
        
        // Start Crawl with Object containing both RLOC and ExtAddress
        // ExtAddress is preferred for API destination
        nodeQueue.push({ rloc: startRloc, ext: startExt });
        processQueue();

    } catch (e) {
        console.error(e); // Log full error to browser console
        log(`Error: ${e.message}`);
        isScanning = false;
        document.getElementById('btnStart').disabled = false;
    }
}

async function processQueue() {
    if (nodeQueue.length === 0) {
        log("Discovery complete.");
        isScanning = false;
        document.getElementById('btnStart').disabled = false;
        return;
    }

    const currentNode = nodeQueue.shift();
    const currentRloc = currentNode.rloc;
    const currentExt = currentNode.ext;
    
    // Use Extended Address for unique visitation check if available, otherwise RLOC
    const visitKey = currentExt || currentRloc;

    if (visitedNodes.has(visitKey)) {
        processQueue();
        return;
    }
    visitedNodes.add(visitKey);

    log(`Probing node ${currentRloc} (${currentExt || '?'})...`);

    try {
        // Step 2: Create Async Task via /api/actions
        // New JSON:API format: Docs example uses "data" array.
        // Try using ExtAddress as destination, fallback to RLOC
        const payload = {
            data: [{
                type: "getNetworkDiagnosticTask",
                attributes: {
                    destination: currentExt || currentRloc,
                    types: ["routerNeighbors", "childTable", "rloc16", "extAddress", "ipv6Addresses"],
                    timeout: 5
                }
            }]
        };
        
        console.log("Sending Payload:", JSON.stringify(payload));
        log(`Probing ${currentRloc} (Ext: ${currentExt}) with destination: ${currentExt || currentRloc}`);

        const taskResp = await fetch(`${API_BASE}/api/actions`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/vnd.api+json',
                'Accept': 'application/vnd.api+json'
            },
            body: JSON.stringify(payload)
        });

        if (!taskResp.ok) {
            const errorText = await taskResp.text();
            console.error("API Error Payload:", errorText); 
            throw new Error(`Task creation failed (${taskResp.status}): ${errorText}`);
        }
        
        const taskJson = normalizeKeys(await taskResp.json());
        
        // Extract Action ID (not the Result ID yet)
        let actionId;
        if (taskJson.data && Array.isArray(taskJson.data)) {
                actionId = taskJson.data[0].id;
        } else if (taskJson.data) {
                actionId = taskJson.data.id;
        }
        
        if (!actionId) throw new Error("Could not parse Action ID from response");

        // Step 3: Poll the Action until 'completed'
        const resultId = await pollAction(actionId);
        
        if (resultId) {
            // Step 4: Fetch the final Diagnostic Report
            const reportResp = await fetch(`${API_BASE}/api/diagnostics/${resultId}`, {
                headers: { 'Accept': 'application/vnd.api+json' }
            });
            const reportJson = normalizeKeys(await reportResp.json());
            
            // Extract attributes from report
            // result data usually looks like { data: [ { attributes: ... } ] } or { data: { attributes: ... } }
            const reportData = Array.isArray(reportJson.data) ? reportJson.data[0] : reportJson.data;
            updateGraph(reportData.attributes);
            log(`Scanned ${currentRloc}`);
        } else {
            log(`Failed to get data for ${currentRloc}`);
        }

    } catch (e) {
        log(`Error probing ${currentRloc}: ${e.message}`);
    }

    // Throttle requests slightly
    setTimeout(processQueue, 300);
}

async function pollAction(actionId) {
    let attempts = 0;
    const maxAttempts = 15;

    while (attempts < maxAttempts) {
        await new Promise(r => setTimeout(r, 1000)); // Wait 1 sec
        
        const statusResp = await fetch(`${API_BASE}/api/actions/${actionId}`, {
            headers: { 'Accept': 'application/vnd.api+json' }
        });
        const statusJson = normalizeKeys(await statusResp.json());
        
        const actionData = Array.isArray(statusJson.data) ? statusJson.data[0] : statusJson.data;
        const status = actionData.attributes.status;
        
        // Debug Log Status
        console.log(`Polling ${actionId}: ${status}`, actionData);

        if (status === 'completed') {
            // FIX: Robustly find the result ID.
            
            // 1. Check standard 'result' relationship
            const rels = actionData.relationships;
            if (rels) {
                if (rels.result && rels.result.data) return rels.result.data.id;
                
                // 2. Scan ALL relationships for something that looks like a diagnostic result
                for (const key in rels) {
                    const r = rels[key];
                    if (r.data && r.data.id && (r.data.type || '').toLowerCase().includes('diagnostic')) {
                        // console.log(`Found Result ID in relationship: ${key}`);
                        return r.data.id;
                    }
                }
            }

            // 3. Check 'included' array for diagnostic objects
            if (statusJson.included && Array.isArray(statusJson.included)) {
                // Find any included item with 'diagnostic' in its type
                const diag = statusJson.included.find(i => (i.type || '').toLowerCase().includes('diagnostic'));
                if (diag) {
                    // console.log(`Found Result ID in included: ${diag.type}`);
                    return diag.id;
                }
            }
            
            console.error("Action completed but no Result ID found.", actionData);
            return null;
        }
        if (status === 'failed' || status === 'stopped') {
            return null;
        }
        attempts++;
    }
    return null; // Timeout
}

function addNodeToGraph(rloc, data, role, startPos = null) {
    if (!rloc) return;
    const rawData = data || {};
    const ext = rawData.extAddress;
    
    let label = rloc;
    if (ext && deviceNames[ext]) {
            label = `${deviceNames[ext]}\n(${rloc})`;
    }

    if (!nodes.get(rloc)) {
        // Determine default color based on role
        let color = role === 'Border Router' ? '#ff9900' : '#97C2FC'; // Default Blue

        // Check if this node is the Leader
        if (currentLeaderId !== null) {
            // RLOC16 is 0xRR00. Router ID is top 6 bits.
            const rId = parseInt(rloc, 16) >> 10;
            if (rId === currentLeaderId) {
                color = '#800080'; // Purple for Leader
                role = `Leader (Router ${rId})`;
            }
        }
        
        // Use supplied role color if specific role string matched
        if (role.includes('Leader')) color = '#800080';

        let title = `Ext: ${ext || '??'}\nRLOC: ${rloc}\nRole: ${role}`;
        if (rawData.ip6) title += `\nIPv6: ${rawData.ip6.join('\n      ')}`;

        const nodeOpts = {
            id: rloc,
            label: label,
            title: title,
            group: role,
            color: color,
            rawData: rawData
        };

        if (startPos) {
            nodeOpts.x = startPos.x;
            nodeOpts.y = startPos.y;
        }

        nodes.add(nodeOpts);
    } else {
        // Update existing node if we now have more info (e.g. valid Ext Address)
        const node = nodes.get(rloc);
        
        // Check for Leader status update if not set
        if (currentLeaderId !== null && node.group && !node.group.startsWith('Leader')) {
                const rId = parseInt(rloc, 16) >> 10;
                if (rId === currentLeaderId) {
                    nodes.update({
                        id: rloc,
                        group: `Leader (Router ${rId})`,
                        color: '#800080',
                        title: (node.title || '').replace(/Role: .*/, `Role: Leader (Router ${rId})`)
                    });
                }
        }
        
        const currentRawData = node.rawData || {};
        // If we didn't have extAddress before but do now, update
        let needsUpdate = false;
        let updates = { id: rloc };

        if (!currentRawData.extAddress && rawData.extAddress) {
            const newExt = rawData.extAddress;
            let newLabel = rloc;
            if (newExt && deviceNames[newExt]) {
               newLabel = `${deviceNames[newExt]}\n(${rloc})`;
            }
            updates.label = newLabel;
            updates.title = (node.title || '').replace('Ext: ??', `Ext: ${newExt}`); // Simple replace
            updates.rawData = { ...currentRawData, extAddress: newExt };
            needsUpdate = true;
        }
        
        // Update IPv6 if provided
        if (rawData.ip6 && (!currentRawData.ip6 || currentRawData.ip6.length === 0)) {
             updates.rawData = updates.rawData || { ...currentRawData };
             updates.rawData.ip6 = rawData.ip6;
             updates.title = (updates.title || node.title) + `\nIPv6: ${rawData.ip6.join('\n      ')}`;
             needsUpdate = true;
        }

        if (needsUpdate) nodes.update(updates);
    }
}

// --- CLI IMPORT PARSER ---
function parseCliInput() {
    const text = document.getElementById('cliInput').value;
    if (!text) return;

    // Reset Graph
    nodes.clear();
    edges.clear();
    visitedNodes.clear();
    nodeQueue.length = 0;
    currentLeaderId = null;

    // Helper to add edges
    const pendingEdges = []; // {fromId, toId, lqi} - using Router IDs, resolve later

    // 1. Split into blocks by "id:"
    // Blocks look like: "id:01 rloc16:0x0400 ..."
    // We split by newline, then look for lines starting with "id:" or indented sections
    const lines = text.split('\n');
    let currentNode = null;
    
    // Quick Router ID to RLOC mapping for second pass
    const idToRloc = {}; 

    lines.forEach(line => {
        line = line.trim();
        if (line.startsWith('id:')) {
            // Start of a node
            // Format: id:01 rloc16:0x0400 ext-addr:b2c9a2836317bc63 ver:5 - me - br
            const parts = line.split(/\s+/);
            const idPart = parts.find(p => p.startsWith('id:'));
            const rlocPart = parts.find(p => p.startsWith('rloc16:'));
            const extPart = parts.find(p => p.startsWith('ext-addr:'));
            const isLeader = line.toLowerCase().includes('leader');
            const isBr = line.toLowerCase().includes('br');

            if (rlocPart) {
                const rloc = rlocPart.split(':')[1];
                const id = idPart ? parseInt(idPart.split(':')[1], 10) : null;
                const ext = extPart ? extPart.split(':')[1] : null;

                currentNode = {
                    rloc: rloc,
                    ext: ext,
                    id: id,
                    role: isLeader ? `Leader (Router ${id})` : (isBr ? 'Border Router' : 'Router'),
                    ip6: [],
                    neighbors: [], // {id, lqi}
                    children: []
                };
                
                if (id !== null) {
                    idToRloc[id] = rloc;
                    if (isLeader) currentLeaderId = id;
                }
                
                // Add to graph immediately
                addNodeToGraph(rloc, { extAddress: ext }, currentNode.role);
            }
        } else if (currentNode && line.includes('-links:{')) {
            // Neighbor Links
            // Format: 3-links:{ 14 17 ... }
            // "3-links" means LQI 3
            const linkMatch = line.match(/(\d)-links:\{\s*([\d\s]+)\s*\}/);
            if (linkMatch) {
                const lqi = parseInt(linkMatch[1]);
                const neighborIds = linkMatch[2].trim().split(/\s+/).map(s => parseInt(s, 10));
                neighborIds.forEach(nId => {
                    currentNode.neighbors.push({ id: nId, lqi: lqi });
                });
            }
        } else if (currentNode && line.startsWith('rloc16:') && line.includes('lq:')) {
            // Child line (indented usually, but we trimmed)
            // Format: rloc16:0x4409 lq:3, mode:-
            const rlocMatch = line.match(/rloc16:(0x[0-9a-fA-F]+)/);
            const lqiMatch = line.match(/lq:(\d)/);
            if (rlocMatch) {
                currentNode.children.push({
                    rloc: rlocMatch[1],
                    lqi: lqiMatch ? parseInt(lqiMatch[1]) : 0
                });
            }
        } else if (currentNode && line.includes(':') && line.length > 20 && !line.includes('ip6-addrs')) {
            // Likely an IP address (heuristic)
            if (line.includes('fd') || line.includes('fe80')) {
                currentNode.ip6.push(line);
            }
        }
        
        // Update stored node data with gathered arrays
        if (currentNode) {
             // We update the node in the dataset with the IP list continuously or at end of block
             // Doing it here inefficiently but safely
             nodes.update({
                 id: currentNode.rloc,
                 rawData: { extAddress: currentNode.ext, ip6: currentNode.ip6 } 
             });
             
             // Queue edges
             if (currentNode.neighbors.length > 0) {
                 currentNode.neighbors.forEach(n => {
                     // Check if already queued? No, just store for post-processing
                     // We need to resolve IDs to RLOCs
                     pendingEdges.push({ from: currentNode.rloc, toId: n.id, lqi: n.lqi });
                 });
                 currentNode.neighbors = []; // Clear to avoid re-adding
             }
             
             if (currentNode.children.length > 0) {
                 currentNode.children.forEach(c => {
                     // Add child node
                     const childRloc = c.rloc;
                     if(!nodes.get(childRloc)) {
                        nodes.add({
                            id: childRloc,
                            label: 'Child\n' + childRloc,
                            group: 'EndDevice',
                            color: '#6c757d',
                            shape: 'dot',
                            size: END_DEVICE_NODE_SIZE
                        });
                     }
                     
                     // Add edge immediately
                     const edgeId = [currentNode.rloc, childRloc].sort().join('-');
                     if (!edges.get(edgeId)) {
                        edges.add({
                            id: edgeId,
                            from: currentNode.rloc,
                            to: childRloc,
                            lqi: c.lqi,
                            dashes: true,
                            color: '#aaa',
                            width: 1,
                            length: 125 // Scaled 2.5x (was 50)
                        });
                     }
                 });
                 currentNode.children = [];
             }
        }
    });
    
    // Pass 2: Create Edges from Pending
    // We only add edges where we know the destination RLOC
    const processedEdgeIds = new Set();
    
    pendingEdges.forEach(e => {
        const toRloc = idToRloc[e.toId];
        if (toRloc) {
            const edgeId = [e.from, toRloc].sort().join('-');
            if (!processedEdgeIds.has(edgeId)) {
                processedEdgeIds.add(edgeId);

                // Calculate color/width based on LQI
                let color = '#dc3545'; // 1
                if (e.lqi === 3) color = '#28a745';
                else if (e.lqi === 2) color = '#ffc107';
                
                // Simple Physics for Imported Data (no RSSI/LinkMargin available in this summary usually)
                // LQI 3 -> Short (375), LQI 1 -> Long (1250)
                // Scaled by 2.5x ("150% longer")
                const length = e.lqi === 3 ? 375 : (e.lqi === 2 ? 750 : 1250);

                edges.add({
                    id: edgeId,
                    from: e.from,
                    to: toRloc,
                    label: `LQI:${e.lqi}`,
                    lqi: e.lqi,
                    color: { color: color, highlight: color },
                    width: e.lqi === 3 ? 3 : 1,
                    length: length
                });
            }
        }
    });

    log("Imported topology from CLI output.");
    document.getElementById('importModal').style.display = 'none';
}

function exportData() {
    const data = {
        nodes: nodes.get(),
        edges: edges.get()
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], {type: "application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `thread-topo-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
}

function updateLinkVisibility() {
    const minLqi = parseInt(document.getElementById('linkFilter').value);
    const updates = [];
    const allEdges = edges.get();
    
    allEdges.forEach(edge => {
        // Retrieve LQI. If undefined (e.g. child links), treat as high quality (99) to keep visible.
        const lqi = edge.lqi !== undefined ? edge.lqi : 99;
        
        const shouldHide = lqi < minLqi;
        
        // Update check: If visibility OR physics state is wrong, update it.
        // We disable physics for hidden edges so they don't pull nodes together invisibly.
        if (edge.hidden !== shouldHide || edge.physics === shouldHide) {
            updates.push({ 
                id: edge.id, 
                hidden: shouldHide,
                physics: !shouldHide // Physics ON if shown, OFF if hidden
            });
        }
    });

    if (updates.length > 0) {
        edges.update(updates);
    }
}

function updateGraph(data) {
    const rloc = data.rloc16;
    
    // Normalize IPv6 list for display
    if (data.ipv6Addresses) {
        data.ip6 = data.ipv6Addresses;
    } else if (data.ip6AddressList) {
        data.ip6 = data.ip6AddressList;
    }

    addNodeToGraph(rloc, data, 'Router');

    // Process Neighbors
    if (data.routerNeighbors) {
        // Pre-calculate positions for purely new nodes to distribute them in a circle
        const newNeighbors = data.routerNeighbors.filter(n => !nodes.get(n.rloc16));
        const parentPositions = network.getPositions([rloc]);
        const parentPos = parentPositions[rloc] || {x: 0, y: 0};
        const distributionRadius = 250; 

        data.routerNeighbors.forEach(n => {
            const neighborRloc = n.rloc16;
            const neighborExt = n.extAddress;
            // FIX: Use linkQualityIn if available, else derive from linkMargin
            let lqi = n.linkQualityIn;
            if (lqi === undefined && n.linkMargin !== undefined) {
                const lm = n.linkMargin;
                if (lm > 20) lqi = 3;
                else if (lm > 10) lqi = 2;
                else if (lm > 2) lqi = 1;
                else lqi = 0;
            }
            
            // Ensure neighbor node exists (placeholder) so edge can connect
            if (!nodes.get(neighborRloc)) {
                // Calculate start position if this is a new node
                let startPos = null;
                const newIndex = newNeighbors.indexOf(n);
                if (newIndex !== -1) {
                    const angle = (newIndex / newNeighbors.length) * 2 * Math.PI;
                    startPos = {
                        x: parentPos.x + distributionRadius * Math.cos(angle),
                        y: parentPos.y + distributionRadius * Math.sin(angle)
                    };
                }

                // Use helper to ensure naming and coloring logic is applied immediately
                // even before we probe the node fully.
                addNodeToGraph(neighborRloc, { extAddress: neighborExt }, 'Router', startPos);
            }

            // Create Edge ID (sorted to prevent duplicates A->B vs B->A)
            const edgeId = [rloc, neighborRloc].sort().join('-');
            
            if (!edges.get(edgeId)) {
                let color = '#dc3545'; // Default Red
                
                // --- PHYSICS MODEL: Linear Length & Stiffness based on Signal ---
                // Signal Source: Link Margin (preferred) or RSSI
                // Link Margin Range: ~0 (bad) to ~80 (perfect).
                // RSSI Range: -90 (bad) to -20 (perfect).
                
                let signalVal = 0; // Baseline
                if (n.linkMargin !== undefined) {
                    signalVal = n.linkMargin; // Higher is better
                } else if (n.averageRssi !== undefined) {
                    // Map RSSI (-90 to -20) to approx Link Margin (5 to 75)
                    signalVal = Math.max(0, n.averageRssi + 95); 
                } else {
                    // Fallback to LQI buckets if no raw data
                    signalVal = lqi * 20; 
                }

                // Calculate Length: Signal decaying with square of distance 
                // LinkMargin 60 -> Dist ~180
                // LinkMargin 10 -> Dist ~450
                // Scaled K for "150% longer" (2.5x base). 2000000 * 6.25 = 12500000
                const K = 12500000;
                let length = Math.sqrt(K / Math.max(1, signalVal));
                length = Math.min(2000, Math.max(375, length));

                // Color still based on standard LQI for recognizability
                if(lqi === 3) color = '#28a745'; 
                else if(lqi === 2) color = '#ffc107'; 
                
                // Main Visible Edge
                // Check current filter setting
                const minLqi = parseInt(document.getElementById('linkFilter').value) || 0;
                const isVisible = lqi >= minLqi;

                edges.add({
                    id: edgeId,
                    from: rloc,
                    to: neighborRloc,
                    lqi: lqi, // Store LQI for filtering
                    label: `LQI:${lqi}\n(${signalVal}dB)`,
                    color: { color: color, highlight: color },
                    width: lqi === 3 ? 3 : 1,
                    length: length,
                    hidden: !isVisible, 
                    physics: isVisible // Only participate in physics if visible
                });
            }

            // Optimization: We check visitedNodes using ExtAddress if possible
            const visitKey = neighborExt || neighborRloc;
            if (!visitedNodes.has(visitKey)) {
                // Check if already in queue
                const alreadyQueued = nodeQueue.some(item => (item.ext && item.ext === neighborExt) || item.rloc === neighborRloc);
                if (!alreadyQueued) {
                        nodeQueue.push({ rloc: neighborRloc, ext: neighborExt });
                }
            }
        });
    }
    
    // Process Children (End Devices)
    // Note: Children are often sleepy end devices (SEDs) and we don't crawl them directly
    // because they don't have neighbors to share. We just display them attached to parent.
    if (data.childTable) {
        // Pre-calculate positions for NEW children to distribute them in a separate circle
        const newChildren = data.childTable.filter(child => {
             const childId = `${rloc}_child_${child.childId}`;
             return !nodes.get(childId);
        });
        const parentPositions = network.getPositions([rloc]);
        const parentPos = parentPositions[rloc] || {x: 0, y: 0};
        const childRadius = 125; 

        data.childTable.forEach((child, index) => {
            // Calculate Child RLOC16: Parent RLOC + Child ID
            // Note: This is an approximation. Child ID is usually the last bits.
            // But for display, we might just use a unique ID.
            const childId = `${rloc}_child_${child.childId}`;
            
            // Add Child Node
            if (!nodes.get(childId)) {
                
                let startX = undefined;
                let startY = undefined;
                const newIndex = newChildren.indexOf(child);
                if (newIndex !== -1) {
                     // Interleave or offset angle to avoid direct overlap with router neighbors
                     const angle = (newIndex / newChildren.length) * 2 * Math.PI + (Math.PI / 3); 
                     startX = parentPos.x + childRadius * Math.cos(angle);
                     startY = parentPos.y + childRadius * Math.sin(angle);
                }

                // Try to guess ExtAddress or matching name if we have a way (we don't easily)
                // Unless we looked up the child table elsewhere. 
                // Usually Diagnostics 'childTable' only gives: { childId, timeout, mode, linkQuality }
                // It does NOT give Extended Address. That is why they are missing ExtAddr.
                
                const isSleepy = child.mode && !child.mode.rxOnWhenIdle;
                const label = `Child ${child.childId}\n${isSleepy ? '(Sleepy)' : ''}`;
                
                const nodeOpts = {
                    id: childId,
                    label: label,
                    title: `Child ID: ${child.childId}\nTimeout: ${child.timeout}\nSleepy: ${isSleepy}`,
                    group: 'EndDevice',
                    shape: isSleepy ? 'dot' : 'diamond', 
                    size: END_DEVICE_NODE_SIZE,
                    color: '#6c757d', 
                    rawData: child
                };

                if (startX !== undefined) {
                    nodeOpts.x = startX;
                    nodeOpts.y = startY;
                }
                
                nodes.add(nodeOpts);
                
                // Add Edge to Parent
                edges.add({
                    from: rloc,
                    to: childId,
                    dashes: true, // Dashed line for child-parent
                    length: 125, // Scaled 2.5x
                    color: { color: '#aaa' }
                });
            }
        });
    }
}