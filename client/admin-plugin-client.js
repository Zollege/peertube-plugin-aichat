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
              <th style="padding: 10px; text-align: left; border: 1px solid #444; color: white;">Video</th>
              <th style="padding: 10px; text-align: left; border: 1px solid #444; color: white;">Status</th>
              <th style="padding: 10px; text-align: center; border: 1px solid #444; color: white;">Transcripts</th>
              <th style="padding: 10px; text-align: center; border: 1px solid #444; color: white;">Snapshots</th>
              <th style="padding: 10px; text-align: left; border: 1px solid #444; color: white;">Processed At</th>
              <th style="padding: 10px; text-align: center; border: 1px solid #444; color: white;">Actions</th>
            </tr>
          </thead>
          <tbody id="aichat-videos-tbody">
          </tbody>
        </table>
        <p id="aichat-no-videos" style="display: none; color: #888;">No videos have been processed yet.</p>
      `
      settingsContainer.appendChild(tableContainer)

      const baseUrl = peertubeHelpers.getBaseRouterRoute()

      // Function to clear video data
      async function clearVideoData(videoUuid, row) {
        if (!confirm('Are you sure you want to clear all AI data for this video? This cannot be undone.')) {
          return
        }

        try {
          const response = await fetch(`${baseUrl}/processing/${videoUuid}`, {
            method: 'DELETE',
            headers: peertubeHelpers.getAuthHeader()
          })

          if (response.ok) {
            row.remove()
            // Check if table is empty
            const tbody = document.getElementById('aichat-videos-tbody')
            if (tbody && tbody.children.length === 0) {
              document.getElementById('aichat-videos-table').style.display = 'none'
              document.getElementById('aichat-no-videos').style.display = 'block'
            }
          } else {
            alert('Failed to clear video data')
          }
        } catch (error) {
          console.error('Error clearing video data:', error)
          alert('Error clearing video data')
        }
      }

      // Fetch processed videos
      try {
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
            const displayName = video.videoName || video.videoUuid.substring(0, 8) + '...'
            row.innerHTML = `
              <td style="padding: 8px; border: 1px solid #444;">
                <a href="/w/${video.videoUuid}" target="_blank" style="color: #00a0d2;">
                  ${displayName}
                </a>
              </td>
              <td style="padding: 8px; border: 1px solid #444;">
                <span style="
                  padding: 2px 8px;
                  border-radius: 4px;
                  font-size: 12px;
                  color: white;
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
              <td style="padding: 8px; border: 1px solid #444; text-align: center;">
                <button class="aichat-clear-btn" style="
                  background: #5a2d2d;
                  color: white;
                  border: none;
                  padding: 4px 8px;
                  border-radius: 4px;
                  cursor: pointer;
                  font-size: 12px;
                ">Clear</button>
              </td>
            `

            // Add click handler for clear button
            const clearBtn = row.querySelector('.aichat-clear-btn')
            clearBtn.addEventListener('click', () => clearVideoData(video.videoUuid, row))

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
