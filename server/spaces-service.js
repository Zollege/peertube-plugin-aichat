const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3')
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner')

let logger = null
let settingsManager = null
let s3Client = null

function initialize(services) {
  logger = services.logger
  settingsManager = services.settingsManager
}

async function getS3Client() {
  if (s3Client) return s3Client

  const accessKey = await settingsManager.getSetting('spaces-access-key')
  const secretKey = await settingsManager.getSetting('spaces-secret-key')
  const region = await settingsManager.getSetting('spaces-region') || 'nyc3'

  if (!accessKey || !secretKey) {
    logger.debug('S3/Spaces credentials not configured')
    return null
  }

  // For DigitalOcean Spaces, the endpoint is https://{region}.digitaloceanspaces.com
  const endpoint = region.includes('.')
    ? `https://${region}`
    : `https://${region}.digitaloceanspaces.com`

  s3Client = new S3Client({
    endpoint,
    region: region.split('.')[0] || region, // Extract just the region code
    credentials: {
      accessKeyId: accessKey,
      secretAccessKey: secretKey
    },
    forcePathStyle: false // Important for Spaces
  })

  logger.info(`Initialized S3 client for region: ${region}`)
  return s3Client
}

async function generateSignedUrl(bucketUrl, objectKey, expiresIn = 21600) {
  try {
    const client = await getS3Client()
    if (!client) {
      logger.debug('Cannot generate signed URL - S3 client not configured')
      return null
    }

    // Extract bucket name from URL
    // Handle both Spaces URLs and custom domains
    let bucketName

    if (bucketUrl.includes('digitaloceanspaces.com')) {
      // e.g., https://peertube-streaming-1.nyc3.cdn.digitaloceanspaces.com -> peertube-streaming-1
      const urlParts = bucketUrl.replace('https://', '').split('.')
      bucketName = urlParts[0]
    } else {
      // For custom domains, we need to map them to bucket names
      // You'll need to configure the actual bucket name
      if (bucketUrl.includes('captions.zollege.tv')) {
        bucketName = 'peertube-captions'
      } else {
        logger.warn(`Unknown custom domain: ${bucketUrl}`)
        return null
      }
    }

    logger.info(`Generating signed URL for bucket: ${bucketName}, key: ${objectKey}`)

    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: objectKey
    })

    const signedUrl = await getSignedUrl(client, command, { expiresIn })
    logger.info(`Generated signed URL (expires in ${expiresIn}s): ${signedUrl}`)

    return signedUrl
  } catch (error) {
    logger.error('Error generating signed URL:', error)
    return null
  }
}

async function getSignedVideoUrl(videoUuid, baseUrl, isStreamingPlaylist = true) {
  try {
    // Get the appropriate prefix
    const prefix = isStreamingPlaylist
      ? await settingsManager.getSetting('spaces-streaming-prefix')
      : await settingsManager.getSetting('spaces-videos-prefix')

    // Determine the object key based on video type
    const filename = isStreamingPlaylist
      ? `${videoUuid}-master.m3u8`
      : `${videoUuid}-720.mp4`

    // Combine prefix and filename
    const objectKey = prefix ? `${prefix}/${filename}` : filename

    const signedUrl = await generateSignedUrl(baseUrl, objectKey)

    if (signedUrl) {
      logger.info(`Got signed URL for video ${videoUuid}: ${signedUrl}`)
      return signedUrl
    }

    // If signed URL fails, return the public URL as fallback
    // This will work for public videos but fail for private ones
    const publicUrl = `${baseUrl}/${objectKey}`
    logger.info(`Using public URL as fallback: ${publicUrl}`)
    return publicUrl

  } catch (error) {
    logger.error('Error getting signed video URL:', error)
    return null
  }
}

async function getSignedCaptionUrl(videoUuid, baseUrl) {
  try {
    // Get the captions prefix
    const prefix = await settingsManager.getSetting('spaces-captions-prefix')

    // Caption file pattern: captions{uuid}-en.vtt
    const filename = `captions${videoUuid}-en.vtt`

    // Combine prefix and filename
    const objectKey = prefix ? `${prefix}/${filename}` : filename

    const signedUrl = await generateSignedUrl(baseUrl, objectKey)

    if (signedUrl) {
      logger.info(`Got signed URL for caption ${videoUuid}`)
      return signedUrl
    }

    // Fallback to public URL
    const publicUrl = `${baseUrl}/${objectKey}`
    logger.debug(`Using public caption URL as fallback: ${publicUrl}`)
    return publicUrl

  } catch (error) {
    logger.error('Error getting signed caption URL:', error)
    return null
  }
}

// Clear cached client when settings change
async function resetClient() {
  s3Client = null
  logger.info('S3 client reset - will reinitialize on next use')
}

module.exports = {
  initialize,
  getS3Client,
  generateSignedUrl,
  getSignedVideoUrl,
  getSignedCaptionUrl,
  resetClient
}