# PeerTube AI Chat Plugin Requirements

## Overview
A PeerTube plugin that adds an AI-powered chat interface alongside videos, allowing users to ask questions about the video content and receive intelligent responses from OpenAI. The plugin will process video content (snapshots, transcripts, metadata) into a vector database for context-aware answers.

## Core Features

### 1. Chat Interface
- **Location**: Sidebar panel next to video player (similar to livechat plugin)
- **Components**:
  - Chat message history display
  - Input field for user questions
  - Send button and keyboard shortcuts (Enter to send)
  - Loading indicators during AI processing
  - Timestamp links in responses
  - Collapsible/expandable chat panel
- **Responsive Design**: Adapt to mobile and desktop layouts

### 2. Video Content Processing

#### 2.1 Data Collection
- **Video Snapshots**:
  - Capture frames every 5 seconds
  - Store as file references in plugin data directory
  - Include timestamp metadata for precise navigation
  - Process via OpenAI Vision API for scene understanding

- **Timestamps & Chapters**:
  - Extract video chapters if available
  - Create automatic timestamp markers every 5 seconds
  - Link responses to specific video moments

- **Transcripts**:
  - Use PeerTube's built-in transcription feature
  - Parse auto-generated captions
  - Time-aligned text for contextual responses
  - Support for uploaded subtitle files (SRT, VTT) as fallback

- **Metadata**:
  - Video title, description, tags
  - Upload date, duration, view count
  - Channel/author information

#### 2.2 Vector Database
- **PostgreSQL with pgvector**:
  - Use existing PeerTube PostgreSQL instance
  - Install pgvector extension for vector operations
  - Store embeddings alongside metadata
  - Efficient similarity search with HNSW indexing

- **Content Processing**:
  - Generate embeddings via OpenAI Embeddings API
  - Split transcripts into 30-second segments
  - Maintain timestamp associations
  - Store visual descriptions from snapshot analysis
  - Index video metadata for hybrid search

### 3. AI Integration

#### 3.1 OpenAI API
- **Configuration**:
  - Admin-provided API key (encrypted storage in settings)
  - Model selection (GPT-4 with vision capabilities)
  - Rate limiting and quota management
  - Custom system prompts per instance

- **Request Handling**:
  - Use GPT-4 Vision for snapshot analysis
  - Use text-embedding-3-small for embeddings
  - Context window management (include relevant snapshots and transcript)
  - Relevant content retrieval from PostgreSQL vector DB
  - Response streaming for better UX

#### 3.2 Response Features
- **Contextual Answers**:
  - Reference specific moments in the video
  - Include clickable timestamps
  - Quote relevant transcript sections

- **Cross-References**:
  - Suggest related videos from the same channel
  - Link to external resources when appropriate
  - Recommend similar content based on topics

### 4. Admin Configuration

#### 4.1 Plugin Settings
- **API Configuration**:
  - OpenAI API key input (encrypted storage)
  - Model selection dropdown
  - Max tokens per request
  - Temperature and other parameters

- **Processing Settings**:
  - Snapshot interval (fixed at 5 seconds)
  - Enable/disable for specific videos
  - Auto-process new uploads (enabled by default)
  - Batch processing for existing videos
  - Hook into video upload/publish events

- **Chat Settings**:
  - Enable/disable per video/channel
  - Moderation options
  - Rate limiting per user
  - Custom welcome messages

#### 4.2 Permissions
- **User Roles**:
  - Admin: Full configuration access
  - Video Owner: Enable/disable for their videos
  - Viewers: Read-only chat access

- **Privacy Controls**:
  - Opt-in/opt-out for video processing
  - Data retention policies
  - GDPR compliance considerations

### 5. User Interface

#### 5.1 Video Watch Page
- **Chat Toggle Button**:
  - Persistent across videos
  - Remember user preference
  - Visual indicator when available

- **Chat Panel**:
  - Fixed or floating positioning
  - Resize handle for width adjustment
  - Mobile-friendly overlay mode

#### 5.2 Admin Dashboard
- **Processing Status**:
  - List of processed/pending videos
  - Retry failed processing
  - Clear vector data option

- **Usage Analytics**:
  - API usage statistics
  - Popular questions tracking
  - User engagement metrics

## Technical Architecture

### Backend Components
1. **Video Processor Service**:
   - FFmpeg integration for snapshots
   - Transcript parser
   - Vector embedding generator

2. **Vector Database Manager**:
   - CRUD operations for embeddings
   - Similarity search implementation
   - Index optimization

3. **AI Service**:
   - OpenAI API client
   - Request queue management
   - Response caching

4. **REST API Endpoints**:
   - `/chat/send` - Send message
   - `/chat/history` - Get chat history
   - `/video/process` - Trigger processing
   - `/admin/settings` - Configuration

### Frontend Components
1. **Chat Widget** (Vanilla JavaScript)
   - Custom elements for modularity
   - Event-driven architecture
   - No framework dependencies
2. **Admin Settings Panel**
3. **Processing Status Dashboard**

### Database Schema (PostgreSQL)
- **plugin_ai_chat_sessions**: User chat histories
- **plugin_ai_video_embeddings**: Vector data with pgvector
- **plugin_ai_video_snapshots**: Image file paths and timestamps
- **plugin_ai_processing_queue**: Pending videos
- **plugin_ai_api_usage**: Usage tracking and quotas

## Development Phases

### Phase 1: MVP (Core Functionality)
- Basic chat interface with vanilla JavaScript
- PostgreSQL pgvector setup
- OpenAI integration (GPT-4 Vision + embeddings)
- Admin settings for API key
- Automatic video processing on upload
- Snapshot extraction every 5 seconds
- PeerTube transcript integration
- Full UI with timestamps and cross-references

### Phase 2: Enhancement
- Related video suggestions
- Batch processing for existing videos
- Usage analytics dashboard
- Response caching

### Phase 3: Advanced Features
- Multi-video context search
- Custom training per channel
- Advanced moderation tools
- Multi-language support

### Phase 4: Optimization
- Performance improvements
- Cost optimization strategies
- Advanced caching layers
- Scalability enhancements

## Dependencies

### NPM Packages (Confirmed)
- `openai` - Official OpenAI client
- `pg` - PostgreSQL client (if not available via PeerTube)
- `pgvector` - PostgreSQL vector operations
- `fluent-ffmpeg` - Video snapshot extraction
- `subtitle` - Transcript parsing (for uploaded files)

### External Services
- OpenAI API (admin-provided key)
- PostgreSQL with pgvector extension

## Security Considerations
- Secure API key storage (encrypted)
- Rate limiting to prevent abuse
- Input sanitization
- CORS configuration for API endpoints
- User authentication via PeerTube

## Performance Requirements
- Chat response time < 3 seconds
- Efficient video processing (background jobs)
- Minimal impact on video playback
- Scalable to handle multiple concurrent users

## Compatibility
- PeerTube version >= 5.0.0 (for latest plugin APIs)
- Modern browsers (Chrome, Firefox, Safari, Edge)
- Mobile responsive design

## Implementation Decisions

1. **Vector Database**: PostgreSQL with pgvector extension
   - Leverages existing PeerTube database infrastructure
   - No additional database services needed
   - Efficient vector similarity search

2. **Snapshot Storage**: Plugin's data directory
   - Store snapshots as JPEG files in `{plugin-data}/snapshots/{video-uuid}/`
   - Reference paths in PostgreSQL
   - Automatic cleanup on video deletion

3. **Processing Triggers**: Automatic on video upload
   - Hook into `action:api.video.uploaded` and `action:api.video.published`
   - Background job queue for processing
   - Manual reprocessing option in admin panel

4. **UI Framework**: Vanilla JavaScript
   - No framework dependencies
   - Custom elements for modularity
   - Lightweight and performant

5. **Transcript Sources**: PeerTube's built-in transcription
   - Primary source: Auto-generated captions from PeerTube
   - Fallback: Uploaded subtitle files (SRT/VTT)
   - Multi-language support based on available transcripts

6. **Cost Management**: Admin-provided API key
   - Instance admin provides and manages OpenAI API key
   - Usage tracking and quotas per video/user
   - Cost estimates displayed in admin dashboard

7. **Caching Strategy**: Hybrid approach
   - Permanently store embeddings in PostgreSQL
   - Cache frequent Q&A pairs for 24 hours
   - Keep chat histories for 30 days (configurable)