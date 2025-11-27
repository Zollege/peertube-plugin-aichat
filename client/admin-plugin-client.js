function register({ registerHook, peertubeHelpers }) {
  console.log('[AI Chat Admin] Script loaded')

  registerHook({
    target: 'action:admin-plugin-settings.init',
    handler: async ({ npmName }) => {
      console.log('[AI Chat Admin] Settings init for:', npmName)
      if (npmName !== 'peertube-plugin-aichat') return

      // Wait a bit for the DOM to be ready
      await new Promise(resolve => setTimeout(resolve, 500))

      const settingsContainer = document.querySelector('my-plugin-show-installed')
      console.log('[AI Chat Admin] Settings container:', settingsContainer)

      if (!settingsContainer) {
        console.error('[AI Chat Admin] Could not find settings container')
        return
      }

      // Create a container for the processed videos table
      const tableContainer = document.createElement('div')
      tableContainer.id = 'aichat-processed-videos'
      tableContainer.innerHTML = `
        <h2 style="margin-top: 30px; margin-bottom: 15px;">Processed Videos</h2>
        <p style="color: #888; margin-bottom: 15px;">Videos with AI embeddings and snapshots</p>
        <div id="aichat-table-loading">Loading...</div>
        <table id="aichat-videos-table" style="display: none; width: 100%; border-collapse: collapse; margin-top: 10px;">
          <thead>
            <tr style="background: #333;">
              <th style="padding: 10px; text-align: left; border: 1px solid #444;">Video UUID</th>
              <th style="padding: 10px; text-align: left; border: 1px solid #444;">Status</th>
              <th style="padding: 10px; text-align: center; border: 1px solid #444;">Transcripts</th>
              <th style="padding: 10px; text-align: center; border: 1px solid #444;">Snapshots</th>
              <th style="padding: 10px; text-align: left; border: 1px solid #444;">Processed At</th>
            </tr>
          </thead>
          <tbody id="aichat-videos-tbody">
          </tbody>
        </table>
        <p id="aichat-no-videos" style="display: none; color: #888;">No videos have been processed yet.</p>
      `
      settingsContainer.appendChild(tableContainer)

      // Fetch processed videos
      try {
        const baseUrl = peertubeHelpers.getBaseRouterRoute()
        const response = await fetch(`${baseUrl}/processing/list`, {
          headers: peertubeHelpers.getAuthHeader()
        })

        if (!response.ok) {
          throw new Error('Failed to fetch')
        }

        const videos = await response.json()
        const loadingEl = document.getElementById('aichat-table-loading')
        const tableEl = document.getElementById('aichat-videos-table')
        const tbodyEl = document.getElementById('aichat-videos-tbody')
        const noVideosEl = document.getElementById('aichat-no-videos')

        loadingEl.style.display = 'none'

        if (videos.length === 0) {
          noVideosEl.style.display = 'block'
        } else {
          tableEl.style.display = 'table'

          videos.forEach(video => {
            const row = document.createElement('tr')
            row.innerHTML = `
              <td style="padding: 8px; border: 1px solid #444;">
                <a href="/w/${video.videoUuid}" target="_blank" style="color: #00a0d2;">
                  ${video.videoUuid.substring(0, 8)}...
                </a>
              </td>
              <td style="padding: 8px; border: 1px solid #444;">
                <span style="
                  padding: 2px 8px;
                  border-radius: 4px;
                  font-size: 12px;
                  background: ${video.status === 'completed' ? '#2d5a2d' : video.status === 'processing' ? '#5a4a2d' : video.status === 'error' ? '#5a2d2d' : '#444'};
                ">${video.status}</span>
              </td>
              <td style="padding: 8px; border: 1px solid #444; text-align: center;">
                ${video.embeddingCount}
              </td>
              <td style="padding: 8px; border: 1px solid #444; text-align: center;">
                ${video.snapshotCount}
              </td>
              <td style="padding: 8px; border: 1px solid #444;">
                ${video.processedAt ? new Date(video.processedAt).toLocaleString() : '-'}
              </td>
            `
            tbodyEl.appendChild(row)
          })
        }
      } catch (error) {
        console.error('Failed to load processed videos:', error)
        document.getElementById('aichat-table-loading').textContent = 'Failed to load processed videos'
      }
    }
  })
}

export { register }
