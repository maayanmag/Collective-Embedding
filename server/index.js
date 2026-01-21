const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client/dist')));

// In-memory storage (cleared on server restart)
let session = {
  id: null,
  isActive: false,
  participants: new Map(), // id -> { name, socketId }
  questions: [],
  currentQuestionIndex: -1,
  responses: new Map(), // questionIndex -> Map(participantId -> { targetParticipantId, channel, timestamp })
  graph: {
    nodes: new Map(), // participantId -> { id, embedding: { cognitive, creative, technical, social }, connections: Map(targetId -> Map(channel -> weight)) }
    edges: new Map(), // edgeId -> { fromNodeId, toNodeId, channel, weight, timestamp }
    identityMap: new Map() // participantId -> name (DELETABLE)
  },
  epochCount: 0,
  identityDeleted: false,
  isPaused: false,
  autoAdvanceTimer: null
};

// Four-channel embedding questions
const defaultQuestions = [
  // Cognitive / Thinking (blue) - 5 questions
  { text: "Who helps you see problems from a new perspective?", channel: "cognitive" },
  { text: "Who asks questions that shift the direction of a discussion?", channel: "cognitive" },
  { text: "Who would you want to learn from intellectually?", channel: "cognitive" },
  { text: "Who tends to frame complex ideas clearly?", channel: "cognitive" },
  { text: "Who brings depth to group conversations?", channel: "cognitive" },
  
  // Creative / Generative (purple) - 5 questions
  { text: "Who brings the most unexpected or original ideas?", channel: "creative" },
  { text: "Who inspires others creatively?", channel: "creative" },
  { text: "Who would you brainstorm with when you feel stuck?", channel: "creative" },
  { text: "Who pushes conceptual boundaries?", channel: "creative" },
  { text: "Who introduces surprising connections between ideas?", channel: "creative" },
  
  // Technical / Execution (green) - 5 questions
  { text: "Who would you go to for solving a complex technical or practical problem?", channel: "technical" },
  { text: "Who would you trust to make things work under pressure?", channel: "technical" },
  { text: "Who would you want as a teammate on a challenging build/prototype task?", channel: "technical" },
  { text: "Who is strongest at translating ideas into working prototypes?", channel: "technical" },
  { text: "Who handles practical constraints well (time, tools, feasibility)?", channel: "technical" },
  
  // Social / Stabilization (orange) - 5 questions
  { text: "Who is the best listener in the group?", channel: "social" },
  { text: "Who brings emotional stability or calm to the team?", channel: "social" },
  { text: "Who raises group morale and energy?", channel: "social" },
  { text: "Who helps resolve tension or conflict when it appears?", channel: "social" },
  { text: "Who makes collaboration feel easier and safer?", channel: "social" }
];

// Channel color mappings
const channels = {
  cognitive: { color: "#3A7BFF", name: "Thinking / Cognitive influence" },
  creative: { color: "#8B5CF6", name: "Creative / Generative influence" },
  technical: { color: "#22C55E", name: "Technical / Execution influence" },
  social: { color: "#F59E0B", name: "Social / Stabilization influence" }
};

// Embedding vector calculations
function calculateEmbeddingVector(participantId) {
  const embedding = { cognitive: 0, creative: 0, technical: 0, social: 0 };
  
  // Calculate incoming weights per channel
  for (const [sourceId, sourceNode] of session.graph.nodes) {
    if (sourceNode.connections && sourceNode.connections.has(participantId)) {
      const channelWeights = sourceNode.connections.get(participantId);
      if (channelWeights instanceof Map) {
        for (const [channel, weight] of channelWeights) {
          embedding[channel] += weight;
        }
      }
    }
  }
  
  // Return raw weights (not percentages) for better vector composition
  return embedding;
}
function generateNodeColor(embedding) {
  const totalWeight = Object.values(embedding).reduce((sum, val) => sum + val, 0);
  if (totalWeight === 0) return "#888888"; // Default gray for unconnected nodes
  
  // Find dominant channel for stronger color representation
  let dominantChannel = null;
  let maxWeight = 0;
  
  for (const [channel, weight] of Object.entries(embedding)) {
    if (weight > maxWeight) {
      maxWeight = weight;
      dominantChannel = channel;
    }
  }
  
  if (!dominantChannel) return "#888888";
  
  // Use dominant channel as base, then blend with secondary channels
  const baseColor = hexToRgb(channels[dominantChannel].color);
  const dominantStrength = Math.min(0.8, maxWeight / totalWeight); // 80% max for base
  
  let r = baseColor.r * dominantStrength;
  let g = baseColor.g * dominantStrength;
  let b = baseColor.b * dominantStrength;
  
  // Add secondary channel influences
  for (const [channel, weight] of Object.entries(embedding)) {
    if (channel !== dominantChannel && weight > 0) {
      const color = hexToRgb(channels[channel].color);
      const factor = (weight / totalWeight) * 0.5; // Secondary channels have less influence
      r += color.r * factor;
      g += color.g * factor;
      b += color.b * factor;
    }
  }
  
  // Ensure colors stay within valid range
  r = Math.min(255, Math.max(0, Math.round(r)));
  g = Math.min(255, Math.max(0, Math.round(g)));
  b = Math.min(255, Math.max(0, Math.round(b)));
  
  return `rgb(${r}, ${g}, ${b})`;
}

// Helper function to convert raw embedding to percentages for UI display
function embeddingToPercentages(embedding) {
  const total = Object.values(embedding).reduce((sum, val) => sum + val, 0);
  if (total === 0) return { cognitive: 0, creative: 0, technical: 0, social: 0 };
  
  // Debug output
  console.log('Raw embedding:', embedding, 'Total:', total);
  
  const percentages = {
    cognitive: Math.round((embedding.cognitive / total) * 100),
    creative: Math.round((embedding.creative / total) * 100), 
    technical: Math.round((embedding.technical / total) * 100),
    social: Math.round((embedding.social / total) * 100)
  };
  
  console.log('Calculated percentages:', percentages);
  return percentages;
}
app.get('/api/session/graph', (req, res) => {
  const nodes = Array.from(session.graph.nodes.entries()).map(([id, node]) => {
    const embedding = calculateEmbeddingVector(id);
    const embeddingPercentages = embeddingToPercentages(embedding);
    const centrality = calculateCentrality(id);
    
    console.log(`Node ${id}:`, 'Raw embedding:', embedding, 'Percentages:', embeddingPercentages);
    
    return {
      id,
      label: session.identityDeleted ? `Node-${String(Array.from(session.graph.nodes.keys()).indexOf(id) + 1).padStart(2, '0')}` : generateAnonymousLabel(id),
      embedding: embeddingPercentages, // Send percentages for UI display
      color: generateNodeColor(embedding), // But use raw weights for color calculation
      size: Math.max(10, centrality.totalVolume * 3 + 15), // Base size + interaction volume
      centrality,
      role: getNodeRole(id),
      isAnonymous: session.identityDeleted,
      description: generateNodeDescription(id, embedding, centrality)
    };
  });
  
  // Generate channel-colored edges
  const edges = [];
  Array.from(session.graph.edges.values()).forEach(edge => {
    console.log('Edge:', edge);
    edges.push({
      source: edge.fromNodeId,
      target: edge.toNodeId,
      channel: edge.channel,
      color: channels[edge.channel].color,
      weight: edge.weight,
      thickness: Math.max(2, Math.min(edge.weight * 3, 10)), // Better thickness scaling
      timestamp: edge.timestamp
    });
  });
  
  console.log('Returning nodes:', nodes.length, 'edges:', edges.length);
  
  res.json({ 
    nodes, 
    edges, 
    channels: Object.entries(channels).map(([key, value]) => ({
      id: key,
      ...value
    }))
  });
});

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 0, g: 0, b: 0 };
}

// Network analysis functions
function calculateCentrality(participantId) {
  const participant = session.graph.nodes.get(participantId);
  if (!participant) return { inDegree: 0, outDegree: 0, betweenness: 0, totalVolume: 0 };
  
  // Calculate total incoming connections across all channels
  let inDegree = 0;
  for (const [sourceId, sourceNode] of session.graph.nodes) {
    if (sourceNode.connections && sourceNode.connections.has(participantId)) {
      const channelWeights = sourceNode.connections.get(participantId);
      if (channelWeights instanceof Map) {
        for (const weight of channelWeights.values()) {
          inDegree += weight;
        }
      } else {
        inDegree += channelWeights || 0; // Legacy support
      }
    }
  }
  
  // Calculate total outgoing connections across all channels
  let outDegree = 0;
  if (participant.connections) {
    for (const channelWeights of participant.connections.values()) {
      if (channelWeights instanceof Map) {
        for (const weight of channelWeights.values()) {
          outDegree += weight;
        }
      } else {
        outDegree += channelWeights || 0; // Legacy support
      }
    }
  }
  
  const betweenness = calculateBetweennessCentrality(participantId);
  const totalVolume = inDegree + outDegree;
  
  return { inDegree, outDegree, betweenness, totalVolume };
}

function calculateBetweennessCentrality(nodeId) {
  // Simplified implementation - in a full version, this would use proper shortest path algorithms
  let betweenness = 0;
  const nodes = Array.from(session.graph.nodes.keys());
  
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (nodes[i] !== nodeId && nodes[j] !== nodeId) {
        // Check if nodeId is on shortest path between nodes[i] and nodes[j]
        if (isOnShortestPath(nodes[i], nodes[j], nodeId)) {
          betweenness += 1;
        }
      }
    }
  }
  
  return betweenness;
}

function isOnShortestPath(start, end, middle) {
  // Simplified check - assumes direct connections indicate shortest paths
  const startNode = session.graph.nodes.get(start);
  const middleNode = session.graph.nodes.get(middle);
  const endNode = session.graph.nodes.get(end);
  
  return startNode?.connections.has(middle) && middleNode?.connections.has(end);
}

        function getNodeRole(participantId) {
            const centrality = calculateCentrality(participantId);
            const { inDegree, outDegree, betweenness } = centrality;
            
            if (betweenness > 2) return "Bridge";
            if (outDegree > inDegree * 1.5) return "Initiator";
            if (inDegree > outDegree * 1.5) return "Amplifier";
            if (inDegree > 3 && outDegree > 3) return "Connector";
            return "Stabilizer";
        }
        
        function generateAnonymousLabel(participantId) {
            // Generate consistent anonymous labels
            const hash = participantId.split('').reduce((a, b) => {
                a = ((a << 5) - a) + b.charCodeAt(0);
                return a & a;
            }, 0);
            const adjectives = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Sigma', 'Theta', 'Lambda', 'Omega'];
            const numbers = Math.abs(hash) % 100;
            const adjective = adjectives[Math.abs(hash) % adjectives.length];
            return `${adjective}-${numbers.toString().padStart(2, '0')}`;
        }

        function generateNodeDescription(participantId, embedding, centrality) {
            const totalConnections = centrality.totalVolume;
            
            // Don't show description if no interactions yet
            if (totalConnections === 0) {
                return "";
            }
            
            const role = getNodeRole(participantId);
            const dominantChannel = Object.entries(embedding).reduce((a, b) => embedding[a[0]] > embedding[b[0]] ? a : b)[0];
            
            let description = `This node exhibits primary ${channels[dominantChannel].name.toLowerCase()} patterns. `;
            
            if (role === "Bridge") {
                description += "Functions as a structural bridge, linking distinct network clusters. ";
            } else if (role === "Amplifier") {
                description += "Amplifies incoming signals across multiple channels. ";
            } else if (role === "Initiator") {
                description += "Initiates connections and generates outward influence patterns. ";
            } else if (role === "Connector") {
                description += "Maintains high bidirectional connectivity across channels. ";
            } else {
                description += "Provides network stabilization through consistent interaction patterns. ";
            }
            
            if (totalConnections > 10) {
                description += "Demonstrates high interaction volume.";
            } else if (totalConnections > 5) {
                description += "Shows moderate interaction engagement.";
            } else {
                description += "Maintains selective interaction patterns.";
            }
            
            return description;
        }

// Function to shuffle array (Fisher-Yates algorithm)
function shuffleArray(array) {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

// API Routes
app.post('/api/session/create', (req, res) => {
  const sessionId = uuidv4();
  session.id = sessionId;
  session.isActive = true;
  
  // Randomize question order while keeping them balanced across channels
  const shuffledQuestions = shuffleArray(req.body.questions || defaultQuestions);
  session.questions = shuffledQuestions;
  
  session.participants.clear();
  session.responses.clear();
  session.graph.nodes.clear();
  session.graph.identityMap.clear();
  session.currentQuestionIndex = -1;
  session.epochCount = 0;
  session.identityDeleted = false;
  
  const joinUrl = `${req.protocol}://${req.get('host')}/join/${sessionId}`;
  
  QRCode.toDataURL(joinUrl, (err, qrCode) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to generate QR code' });
    }
    
    res.json({
      sessionId,
      joinUrl,
      qrCode
    });
  });
});

app.get('/api/session/status', (req, res) => {
  if (!session.id) {
    return res.json({ active: false });
  }
  
  res.json({
    active: session.isActive,
    participantCount: session.participants.size,
    currentQuestionIndex: session.currentQuestionIndex,
    totalQuestions: session.questions.length,
    epochCount: session.epochCount,
    identityDeleted: session.identityDeleted
  });
});

app.get('/api/session/graph', (req, res) => {
  const nodes = Array.from(session.graph.nodes.entries()).map(([id, node]) => {
    const embedding = calculateEmbeddingVector(id);
    const centrality = calculateCentrality(id);
    
    return {
      id,
      label: session.identityDeleted ? `Node-${String(Array.from(session.graph.nodes.keys()).indexOf(id) + 1).padStart(2, '0')}` : generateAnonymousLabel(id),
      embedding,
      color: generateNodeColor(embedding),
      size: Math.max(10, centrality.totalVolume * 5 + 15), // Base size + interaction volume
      centrality,
      role: getNodeRole(id),
      isAnonymous: session.identityDeleted,
      description: generateNodeDescription(id, embedding, centrality)
    };
  });
  
  // Generate channel-colored edges
  const edges = [];
  Array.from(session.graph.edges.values()).forEach(edge => {
    edges.push({
      source: edge.fromNodeId,
      target: edge.toNodeId,
      channel: edge.channel,
      color: channels[edge.channel].color,
      weight: edge.weight,
      thickness: Math.max(2, Math.min(edge.weight * 3, 10)), // Better thickness scaling
      timestamp: edge.timestamp
    });
  });
  
  res.json({ 
    nodes, 
    edges, 
    channels: Object.entries(channels).map(([key, value]) => ({
      id: key,
      ...value
    }))
  });
});

// Add node profile endpoint
app.get('/api/session/node/:nodeId', (req, res) => {
  const { nodeId } = req.params;
  const node = session.graph.nodes.get(nodeId);
  
  if (!node) {
    return res.status(404).json({ error: 'Node not found' });
  }
  
  const embedding = calculateEmbeddingVector(nodeId);
  const embeddingPercentages = embeddingToPercentages(embedding);
  const centrality = calculateCentrality(nodeId);
  const role = getNodeRole(nodeId);
  
  res.json({
    id: nodeId,
    label: session.identityDeleted ? `Node-${String(Array.from(session.graph.nodes.keys()).indexOf(nodeId) + 1).padStart(2, '0')}` : generateAnonymousLabel(nodeId),
    embedding: embeddingPercentages, // Send percentages for UI display
    centrality,
    role,
    description: generateNodeDescription(nodeId, embedding, centrality),
    connections: Array.from(node.connections.entries()).map(([targetId, channelWeights]) => ({
      targetId,
      targetLabel: session.identityDeleted ? `Node-${String(Array.from(session.graph.nodes.keys()).indexOf(targetId) + 1).padStart(2, '0')}` : generateAnonymousLabel(targetId),
      channels: Array.from(channelWeights.entries()).map(([channel, weight]) => ({
        channel,
        weight,
        color: channels[channel].color
      }))
    }))
  });
});

app.post('/api/session/next-question', (req, res) => {
  // Check if all participants have answered the current question
  if (session.currentQuestionIndex >= 0) {
    const currentResponses = session.responses.get(session.currentQuestionIndex);
    const responseCount = currentResponses ? currentResponses.size : 0;
    const participantCount = session.participants.size;
    
    if (responseCount < participantCount && participantCount > 0) {
      return res.json({ 
        success: false, 
        message: `Waiting for all participants to answer. ${responseCount}/${participantCount} have responded.`,
        waitingForResponses: true,
        responseCount,
        participantCount
      });
    }
  }
  
  if (session.currentQuestionIndex < session.questions.length - 1) {
    session.currentQuestionIndex++;
    const question = session.questions[session.currentQuestionIndex];
    
    io.emit('new-question', {
      questionIndex: session.currentQuestionIndex,
      question: question.text, // Send just the text, not the whole object
      channel: question.channel,
      participants: Array.from(session.participants.values()).map(p => ({ id: p.id, name: p.name }))
    });
    
    res.json({ success: true, question, questionIndex: session.currentQuestionIndex });
  } else {
    res.json({ success: false, message: 'No more questions' });
  }
});

app.post('/api/session/epoch-update', (req, res) => {
  session.epochCount++;
  io.emit('epoch-update', { epochCount: session.epochCount });
  res.json({ success: true, epochCount: session.epochCount });
});

// Auto-advance logic
function checkForAutoAdvance(questionIndex) {
  if (session.isPaused) return;
  
  const currentResponses = session.responses.get(questionIndex);
  const responseCount = currentResponses ? currentResponses.size : 0;
  const participantCount = session.participants.size;
  
  // If all participants have answered, wait 5 seconds then advance
  if (responseCount >= participantCount && participantCount > 0) {
    clearTimeout(session.autoAdvanceTimer);
    session.autoAdvanceTimer = setTimeout(() => {
      advanceToNextQuestion();
    }, 5000); // 5 second delay
  }
}

function advanceToNextQuestion() {
  if (session.isPaused) return;
  
  if (session.currentQuestionIndex < session.questions.length - 1) {
    session.currentQuestionIndex++;
    const question = session.questions[session.currentQuestionIndex];
    
    // Update epoch
    session.epochCount++;
    
    io.emit('new-question', {
      questionIndex: session.currentQuestionIndex,
      question: question.text,
      channel: question.channel,
      participants: Array.from(session.participants.values()).map(p => ({ id: p.id, name: p.name }))
    });
    
    io.emit('epoch-update', { epochCount: session.epochCount });
  } else {
    // All questions completed - notify participants
    io.emit('session-complete', {
      message: 'All questions completed',
      totalQuestions: session.questions.length,
      epochCount: session.epochCount
    });
  }
}

// Pause/resume endpoint
app.post('/api/session/pause-resume', (req, res) => {
  const { pause } = req.body;
  
  if (pause) {
    session.isPaused = true;
    clearTimeout(session.autoAdvanceTimer);
  } else {
    session.isPaused = false;
    // Check if we should auto-advance current question
    if (session.currentQuestionIndex >= 0) {
      checkForAutoAdvance(session.currentQuestionIndex);
    }
  }
  
  res.json({ success: true, paused: session.isPaused });
});

// End session endpoint
app.post('/api/session/end', (req, res) => {
  if (!session.isActive) {
    return res.json({ success: false, message: 'No active session to end' });
  }
  
  // Clear any running timers
  clearTimeout(session.autoAdvanceTimer);
  
  // Notify all participants that session ended
  io.emit('session-ended', {
    message: 'Session ended by administrator',
    reason: 'admin_terminated'
  });
  
  // Reset session state
  session.id = null;
  session.isActive = false;
  session.participants.clear();
  session.responses.clear();
  session.graph.nodes.clear();
  session.graph.edges.clear();
  session.graph.identityMap.clear();
  session.currentQuestionIndex = -1;
  session.epochCount = 0;
  session.identityDeleted = false;
  session.isPaused = false;
  
  res.json({ success: true, message: 'Session ended successfully' });
});

// Start first question automatically (for auto-advance mode)
app.post('/api/session/start-questions', (req, res) => {
  if (session.currentQuestionIndex >= 0) {
    return res.json({ success: false, message: 'Questions already started' });
  }
  
  advanceToNextQuestion();
  res.json({ success: true });
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.on('join-session', (data) => {
    const { sessionId, name } = data;
    
    if (sessionId !== session.id || !session.isActive) {
      socket.emit('join-error', { message: 'Invalid session' });
      return;
    }
    
    if (session.participants.size >= 20) {
      socket.emit('join-error', { message: 'Session is full' });
      return;
    }
    
    const participantId = uuidv4();
    session.participants.set(participantId, {
      id: participantId,
      name,
      socketId: socket.id
    });
    
    // Initialize node in graph with embedding structure
    session.graph.nodes.set(participantId, {
      id: participantId,
      embedding: { cognitive: 0, creative: 0, technical: 0, social: 0 },
      connections: new Map()
    });
    
    if (!session.identityDeleted) {
      session.graph.identityMap.set(participantId, name);
    }
    
    socket.participantId = participantId;
    
    socket.emit('joined', {
      participantId,
      participantCount: session.participants.size
    });
    
    io.emit('participant-joined', {
      participantCount: session.participants.size
    });
  });
  
  socket.on('submit-response', (data) => {
    const { questionIndex, targetParticipantId } = data;
    const participantId = socket.participantId;
    
    if (!participantId || questionIndex !== session.currentQuestionIndex) {
      return;
    }
    
    const question = session.questions[questionIndex];
    const channel = question.channel;
    const timestamp = Date.now();
    
    // Store response with channel information
    if (!session.responses.has(questionIndex)) {
      session.responses.set(questionIndex, new Map());
    }
    session.responses.get(questionIndex).set(participantId, {
      targetParticipantId,
      channel,
      timestamp
    });
    
    // Update graph with channel-specific connections
    const sourceNode = session.graph.nodes.get(participantId);
    if (sourceNode && targetParticipantId) {
      if (!sourceNode.connections.has(targetParticipantId)) {
        sourceNode.connections.set(targetParticipantId, new Map());
      }
      
      const channelWeights = sourceNode.connections.get(targetParticipantId);
      const currentWeight = channelWeights.get(channel) || 0;
      channelWeights.set(channel, currentWeight + 1);
      
      // Create/update edge
      const edgeId = `${participantId}-${targetParticipantId}-${channel}`;
      session.graph.edges.set(edgeId, {
        fromNodeId: participantId,
        toNodeId: targetParticipantId,
        channel,
        weight: currentWeight + 1,
        timestamp
      });
    }
    
    socket.emit('response-submitted');
    
    // Notify admin of response count
    const responseCount = session.responses.get(questionIndex)?.size || 0;
    io.emit('response-count-update', {
      questionIndex,
      responseCount,
      totalParticipants: session.participants.size
    });
    
    // Check for auto-advance after response is submitted
    checkForAutoAdvance(questionIndex);
  });
  
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // Remove participant if they were connected
    for (let [id, participant] of session.participants) {
      if (participant.socketId === socket.id) {
        session.participants.delete(id);
        io.emit('participant-left', {
          participantCount: session.participants.size
        });
        break;
      }
    }
  });
});

// Serve client files
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/admin.html'));
});

app.get('/join/:sessionId', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/participant.html'));
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../client/index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Collective Embedding server running on port ${PORT}`);
  console.log(`Admin interface: http://localhost:${PORT}/admin`);
});
