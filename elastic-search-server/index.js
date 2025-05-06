const express = require('express');
const { Client } = require('@elastic/elasticsearch');
const multer = require('multer');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const OpenAI = require('openai');

const app = express();
const port = 5000;

// Create an HTTP server and attach Socket.io to it.
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*'
  }
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Connect to Elasticsearch (running at localhost:9200)
const client = new Client({ node: 'http://localhost:9200' });

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, 'uploads/'); // Ensure this folder exists.
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  },
});
const upload = multer({ storage });

// Ensure posts index exists.
async function ensurePostsIndex() {
  const indexName = 'es_index7';
  try {
    const { body: exists } = await client.indices.exists({ index: indexName });
    if (!exists) {
      await client.indices.create({
        index: indexName,
        body: {
          mappings: {
            properties: {
              image: { type: 'keyword' },
            },
          },
        },
      });
      console.log(`Index ${indexName} created with mapping.`);
    } else {
      console.log(`Index ${indexName} already exists.`);
    }
  } catch (error) {
    if (
      error.meta &&
      error.meta.body &&
      error.meta.body.error &&
      error.meta.body.error.type === 'resource_already_exists_exception'
    ) {
      console.log(`Index ${indexName} already exists.`);
    } else {
      console.error('Error ensuring posts index:', error);
    }
  }
}
ensurePostsIndex().catch(console.error);

async function ensureNotificationsIndex() {
  const indexName = 'notifications_index2';
  try {
    const existsResponse = await client.indices.exists({ index: indexName });
    if (!existsResponse.body) {
      await client.indices.create({
        index: indexName,
        body: {
          mappings: {
            properties: {
              username: { type: 'keyword' },
              message: { type: 'text' },
              timestamp: { type: 'date' },
              postId: { type: 'keyword' },
              topic: { type: 'keyword' },
              read: { type: 'boolean' }
            }
          }
        }
      });
      console.log(`Index ${indexName} created for notifications.`);
    } else {
      console.log(`Index ${indexName} already exists.`);
    }
  } catch (error) {
    // If error is resource_already_exists_exception, ignore it.
    if (error.meta?.body?.error?.type === 'resource_already_exists_exception') {
      console.log(`Index ${indexName} already exists.`);
    } else {
      console.error('Error ensuring notifications index:', error);
    }
  }
}
ensureNotificationsIndex().catch(console.error);



/*
  SOCKET.IO SETUP
  - "register": registers a socket with the username.
  - "subscribeToTopic": makes the socket join a room named after the topic.
*/
const userSubscriptions = {};

io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  socket.on('register', (username) => {
    socket.username = username;
    socket.join(username);
    console.log(`Socket ${socket.id} registered as ${username}`);
  });

  socket.on('subscribeToTopic', (topic) => {
    socket.join(topic);
    console.log(`Socket ${socket.id} joined topic ${topic}`);
    if (socket.username) {
      if (!userSubscriptions[socket.username]) {
        userSubscriptions[socket.username] = new Set();
      }
      userSubscriptions[socket.username].add(topic);
    }
  });

  socket.on('unsubscribeFromTopic', (topic) => {
    socket.leave(topic);
    console.log(`Socket ${socket.id} left topic ${topic}`);
    if (socket.username && userSubscriptions[socket.username]) {
      userSubscriptions[socket.username].delete(topic);
    }
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

async function createNotification(username, notification) {
  try {
    await client.index({
      index: 'notifications_index',
      document: {
        username,
        ...notification,
        read: false
      },
      refresh: true
    });
    console.log(`Notification stored for ${username}`);
  } catch (error) {
    console.error('Error storing notification:', error);
  }
}

app.post('/posts', upload.single('image'), async (req, res) => {
  try {
    const { id, title, topic, description, author, dateCreated } = req.body;
    const imageUrl = req.file
      ? `http://localhost:${port}/uploads/${req.file.filename}`
      : null;

    const post = { id, title, topic, description, author, dateCreated, image: imageUrl };

    const response = await client.index({
      index: 'es_index7',
      id: post.id,
      document: post,
      refresh: true,
    });

    const message = `New post in ${topic} posted by ${author}: ${title}`;
    const notification = {
      message,
      timestamp: new Date(),
      postId: id,
      topic,
    };

    for (const username in userSubscriptions) {
      if (userSubscriptions[username].has(topic)) {
        await createNotification(username, notification);
        io.to(username).emit('newPost', notification);
        console.log(`Notified ${username} about new post in topic "${topic}".`);
      }
    }

    res.status(201).json(response);
  } catch (error) {
    console.error('Error indexing document:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/notifications/:username', async (req, res) => {
  console.log("notificationssssssssssssssssss")
  const { username } = req.params;
  try {
    const response = await client.search({
      index: 'notifications_index',
      body: {
        query: {
          term: { username }
        },
        sort: [{ timestamp: { order: 'desc' } }]
      }
    });
    const notifications = response.hits.hits.map(hit => hit._source);
    res.json({ notifications });
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/notifications/:username/clear', async (req, res) => {
  const { username } = req.params;
  try {
    const response = await client.deleteByQuery({
      index: 'notifications_index',
      body: {
        query: {
          term: { username }
        }
      },
      refresh: true
    });
    res.json({ message: `Cleared notifications for ${username}` });
  } catch (error) {
    console.error('Error clearing notifications:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/posts', async (req, res) => {
  console.log('Fetching all posts');
  try {
    const response = await client.search({
      index: 'es_index7',
      query: { match_all: {} },
    });
    res.json(response.hits.hits.map(hit => hit._source));
  } catch (error) {
    console.error('Error fetching posts:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/posts/:topic', async (req, res) => {
  console.log('Selecting using topics');
  try {
    const { topic } = req.params;
    const response = await client.search({
      index: 'es_index7',
      query: { match: { topic } },
    });
    res.json(response.hits.hits.map(hit => hit._source));
  } catch (error) {
    console.error('Error fetching posts by topic:', error);
    res.status(500).json({ error: error.message });
  }
});

app.put('/posts/:id', async (req, res) => {
  const postId = req.params.id;
  const updatedPost = req.body;
  try {
    const result = await client.update({
      index: 'es_index7',
      id: postId,
      body: { doc: updatedPost },
    });
    res.status(200).json(result);
  } catch (error) {
    console.error('Error updating post:', error);
    res.status(500).json({ error: 'Failed to update post' });
  }
});

app.delete('/posts/:id', async (req, res) => {
  const postId = req.params.id;
  try {
    const result = await client.delete({
      index: 'es_index7',
      id: postId,
      refresh: true,
    });
    res.status(200).json(result);
  } catch (error) {
    console.error('Error deleting post:', error);
    res.status(500).json({ error: 'Failed to delete post' });
  }
});

app.get('/search', async (req, res) => {
  const queryText = req.query.q;
  if (!queryText) {
    return res.status(400).json({ error: 'Missing search query parameter "q".' });
  }
  try {
    const response = await client.search({
      index: 'es_index7',
      size: 100,
      body: {
        query: {
          multi_match: {
            query: queryText,
            fields: ['title', 'topic', 'description'],
            fuzziness: 'AUTO',
          },
        },
      },
    });
    res.json(response.hits.hits.map(hit => hit._source));
  } catch (error) {
    console.error('Error searching posts:', error);
    res.status(500).json({ error: error.message });
  }
});


app.post('/subscribe', (req, res) => {
  const { username, topic } = req.body;
  if (!username || !topic) {
    return res.status(400).json({ error: 'username and topic are required' });
  }
  res.json({ message: `Subscribed ${username} to ${topic}` });
});


app.post('/unsubscribe', (req, res) => {
  const { username, topic } = req.body;
  if (!username || !topic) {
    return res.status(400).json({ error: 'username and topic are required' });
  }
  
  if (userSubscriptions[username]) {
    userSubscriptions[username].delete(topic);
  }
  
  res.json({ message: `Unsubscribed ${username} from ${topic}` });
});


app.get('/subscriptions/:username', (req, res) => {
  const { username } = req.params;
  const topicsSet = userSubscriptions[username];
  const topics = topicsSet ? Array.from(topicsSet) : [];
  res.json({ topics });
});


app.post('/generateReply', async (req, res) => {
  const { prompt, useAIGeneratedReply } = req.body;
  const fullPrompt = `Transform the short phrase "${prompt}" into a longer, more detailed and engaging reply that demonstrates a formal tone.  Do *not* simply provide feedback or thank the author. Elaborate, expand, and rephrase the text into a new reply that still captures the text in less than 15 words. Respond in a formal tone. Be concise and avoid extra details`;

  if (!useAIGeneratedReply) {
    return res.status(400).json({ error: 'AI-generated reply is disabled.' });
  }
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt is required.' });
  }
  try {
    const openaiResponse = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-4o-mini', // or "gpt-4" if available
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: fullPrompt },
        ],
        temperature: 0.7,
        max_tokens: 150,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );
    const reply = openaiResponse.data.choices[0].message.content;
    res.json({ reply });
  } catch (error) {
    console.error('Error generating reply:', error.response ? error.response.data : error.message);
    res.status(500).json({ error: 'Error generating AI reply.' });
  }
});

app.get('/proxy-serpapi', async (req, res) => {
  const { q } = req.query;
  try {
    const response = await axios.get(`https://serpapi.com/search?engine=google&q=${encodeURIComponent(q)}&api_key=${SERPAPI_KEY}`);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


server.listen(port, () => console.log(`Server running on port ${port}`));
