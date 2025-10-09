# PeerTube AI Chat Plugin (peertube-plugin-aichat)

An AI-powered chat plugin for PeerTube that allows viewers to ask questions about video content and receive intelligent responses using OpenAI's GPT-4.

## Features

- 🤖 **AI-Powered Chat**: Ask questions about the video and get contextual answers
- 📸 **Video Snapshot Analysis**: Extracts and analyzes video frames at configurable intervals
- 📝 **Transcript Integration**: Uses PeerTube's built-in transcription for context
- ⏱️ **Timestamp Navigation**: Click on timestamps in responses to jump to specific moments
- 🔍 **Vector Search**: Uses PostgreSQL with pgvector for semantic similarity search
- 💬 **Chat History**: Maintains conversation history per video
- 🎨 **Responsive Design**: Works on desktop and mobile devices

## Prerequisites

1. **PeerTube Instance**: Version >= 5.0.0
2. **PostgreSQL with pgvector**: The pgvector extension must be installed
3. **OpenAI API Key**: Required for GPT-4 and embeddings
4. **FFmpeg**: Required for video snapshot extraction

### Installing pgvector

```bash
# Ubuntu/Debian
sudo apt install postgresql-14-pgvector

# macOS with Homebrew
brew install pgvector

# From source
git clone https://github.com/pgvector/pgvector.git
cd pgvector
make
make install
```

## Installation

1. **Build the plugin** (if installing from source):
```bash
npm install
npm run build
```

2. **Install on PeerTube**:
```bash
# Using PeerTube CLI
peertube-cli plugins install --path /path/to/peertube-plugin-aichat

# Or copy to PeerTube plugins directory
cp -r peertube-plugin-aichat /var/www/peertube/storage/plugins/
```

3. **Configure the plugin**:
   - Go to Admin > Plugins > AI Chat > Settings
   - Enter your OpenAI API key
   - Configure other settings as needed

## Configuration

### Required Settings

- **OpenAI API Key**: Your OpenAI API key for GPT-4 and embeddings
- **Enable AI Chat**: Toggle to enable/disable the chat feature
- **Auto-process videos**: Automatically process new video uploads

### Optional Settings

- **Snapshot Interval**: Set the interval between video snapshots (1-60 seconds, default: 5)
- **OpenAI Model**: Choose from GPT-4.1-nano, GPT-4.1-mini, GPT-4.1, GPT-4o-mini, GPT-4o, GPT-4 Turbo, or GPT-4
- **Max Response Tokens**: Maximum tokens for AI responses (default: 1000)
- **System Prompt**: Customize the AI assistant's behavior

## How It Works

1. **Video Processing**:
   - When a video is uploaded, the plugin automatically:
     - Extracts snapshots at the configured interval (1-60 seconds)
     - Analyzes snapshots using the configured model (all models support vision)
     - Processes video transcripts
     - Generates embeddings for semantic search

2. **Chat Interface**:
   - Users can ask questions about the video
   - The AI searches for relevant context using vector similarity
   - Responses include clickable timestamps to navigate the video

3. **Data Storage**:
   - Uses PostgreSQL with pgvector for embeddings
   - Stores snapshots in the plugin's data directory
   - Maintains chat history in the database

## API Endpoints

- `POST /plugins/aichat/router/chat/send` - Send a chat message
- `GET /plugins/aichat/router/chat/history/:videoId` - Get chat history
- `GET /plugins/aichat/router/processing/status/:videoUuid` - Check processing status
- `POST /plugins/aichat/router/processing/trigger/:videoUuid` - Manually trigger processing (admin only)

## Development

### Project Structure

```
peertube-plugin-aichat/
├── client/                  # Client-side code
│   ├── common-client-plugin.js
│   └── video-watch-client.js
├── server/                  # Server-side services
│   ├── database-service.js
│   ├── openai-service.js
│   ├── video-processor.js
│   └── chat-service.js
├── assets/                  # CSS styles
│   └── style.css
├── dist/                    # Built client files
├── main.js                  # Plugin entry point
└── package.json
```

### Building

```bash
npm run build
```

### Testing

1. Install the plugin on a test PeerTube instance
2. Configure the OpenAI API key in settings
3. Upload a video with captions/transcription
4. Wait for processing to complete
5. Open the video and test the chat interface

## Troubleshooting

### pgvector not installed

If you see errors about pgvector, ensure it's installed and the PostgreSQL user has permissions:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

### Video processing fails

Check the logs for errors:
```bash
journalctl -u peertube -f
```

Common issues:
- FFmpeg not found
- Insufficient disk space for snapshots
- OpenAI API key invalid or quota exceeded

### Chat not appearing

1. Check if chat is enabled in plugin settings
2. Verify the video has been processed
3. Check browser console for JavaScript errors

## Cost Considerations

This plugin uses OpenAI's API which incurs costs:
- Vision analysis for snapshots (configurable model)
- Text embeddings for semantic search (text-embedding-3-small)
- Chat responses (configurable model)

Model cost comparison for vision (from lowest to highest cost):
- **GPT-4.1-nano**: Most cost-efficient (2.46x multiplier for vision tokens)
- **GPT-4.1-mini**: Very cost-efficient (1.62x multiplier for vision tokens)
- **GPT-4o-mini**: Good for basic tasks (2833 base tokens)
- **GPT-4.1**: Latest balanced model
- **GPT-4o**: Previous generation balanced (85 base tokens)
- **GPT-4 Turbo**: Higher quality, higher cost
- **GPT-4**: Highest quality, highest cost

Monitor your usage in the OpenAI dashboard and set appropriate limits.

## Contributing

Contributions are welcome! Please submit issues and pull requests on GitHub.

## License

AGPL-3.0

## Support

For issues and questions, please use the GitHub issue tracker.