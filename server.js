const path = require('path');
const express = require('express');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_NINJAS_KEY;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/planets', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({
      error: 'Missing API_NINJAS_KEY. Add it to your .env file.'
    });
  }

  try {
    const response = await fetch('https://api.api-ninjas.com/v1/planets?min_mass=0', {
      headers: {
        'X-Api-Key': API_KEY
      }
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({
        error: 'Failed to fetch planets from upstream API.',
        details: errText
      });
    }

    const planets = await response.json();
    return res.json(planets);
  } catch (error) {
    return res.status(500).json({
      error: 'Unexpected error while calling API Ninjas.',
      details: error.message
    });
  }
});

app.get('*', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Universe app running at http://localhost:${PORT}`);
});
