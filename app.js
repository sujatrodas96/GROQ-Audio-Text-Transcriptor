import express from "express";
import multer from "multer";
import fs from "fs";
import mime from "mime-types";
import dotenv from "dotenv";
import FormData from "form-data";
import fetch from "node-fetch";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static"; // Add this import
import path from "path";

dotenv.config();

const app = express();
const PORT = 3000;

const UPLOAD_DIR = "uploads";
const CHUNK_DIR = "chunks";

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
if (!fs.existsSync(CHUNK_DIR)) fs.mkdirSync(CHUNK_DIR);

// Set both ffmpeg and ffprobe paths
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobeStatic.path || ffprobeStatic); // Handle both object and string formats

const upload = multer({ dest: UPLOAD_DIR });

app.get("/test-api", async (req, res) => {
  try {
    // Test API key and get available models
    const response = await fetch("https://api.groq.com/openai/v1/models", {
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      return res.json({
        error: true,
        status: response.status,
        message: errorData
      });
    }
    
    const models = await response.json();
    const audioModels = models.data.filter(model => 
      model.id.includes('whisper') || model.id.includes('distil')
    );
    
    res.json({
      success: true,
      message: "API key is working!",
      availableAudioModels: audioModels.map(m => ({
        id: m.id,
        owned_by: m.owned_by
      }))
    });
    
  } catch (error) {
    res.json({
      error: true,
      message: error.message
    });
  }
});

app.get("/", (req, res) => {
  res.send(`
    <h2>🎤 Upload Audio/Video → Get English Transcript via Groq</h2>
    
    <div style="margin-bottom: 20px; padding: 10px; background: #f0f0f0; border-radius: 5px;">
      <h3>🔧 Test API Connection</h3>
      <button onclick="testAPI()">Test Groq API Key</button>
      <div id="apiResult" style="margin-top: 10px;"></div>
    </div>
    
    <div style="margin-bottom: 20px; padding: 10px; background: #e8f4f8; border-radius: 5px; border-left: 4px solid #007bff;">
      <h4>📋 How it works:</h4>
      <ul>
        <li>Upload any audio or video file</li>
        <li>File is split into chunks for better processing</li>
        <li><strong>Output is always in English</strong> (translates if needed)</li>
        <li>Get complete transcript with download options</li>
      </ul>
    </div>
    
    <form method="POST" action="/upload" enctype="multipart/form-data">
      <input type="file" name="audio" accept="audio/*,video/*" required />
      <br><br>
      <label>
        <input type="checkbox" name="detectLanguage" value="true" checked />
        Auto-detect source language (but output will be English)
      </label>
      <br><br>
      <button type="submit">Upload & Transcribe to English</button>
    </form>
    
    <script>
      async function testAPI() {
        const resultDiv = document.getElementById('apiResult');
        resultDiv.innerHTML = '⏳ Testing API connection...';
        
        try {
          const response = await fetch('/test-api');
          const data = await response.json();
          
          if (data.success) {
            resultDiv.innerHTML = \`
              <div style="color: green;">✅ API Key is working!</div>
              <div><strong>Available Models:</strong></div>
              <ul>\${data.availableAudioModels.map(m => \`<li>\${m.id}</li>\`).join('')}</ul>
            \`;
          } else {
            resultDiv.innerHTML = \`
              <div style="color: red;">❌ API Error: \${data.message}</div>
            \`;
          }
        } catch (error) {
          resultDiv.innerHTML = \`
            <div style="color: red;">❌ Connection Error: \${error.message}</div>
          \`;
        }
      }
    </script>
  `);
});

app.post("/upload", upload.single("audio"), async (req, res) => {
  const filePath = req.file.path;
  const fileName = req.file.originalname;
  const detectLanguage = req.body.detectLanguage === "true";
  
  console.log(`🎵 Processing: ${fileName}`);
  console.log(`📋 Language detection: ${detectLanguage ? 'ON' : 'OFF'}`);

  try {
    // Step 1: Enhanced chunking to ensure all audio is captured
    const chunkPaths = await splitIntoChunksEnhanced(filePath, CHUNK_DIR, 90); // Reduced chunk size for better coverage
    console.log(`✂️ Split into ${chunkPaths.length} chunks`);

    // Step 2: Transcribe each chunk with retry logic
    let fullTranscript = "";
    let processedChunks = 0;
    let failedChunks = [];
    const chunkResults = [];
    
    for (let i = 0; i < chunkPaths.length; i++) {
      const chunkPath = chunkPaths[i];
      console.log(`🔄 Processing chunk ${i + 1}/${chunkPaths.length}`);
      
      // Check if chunk file exists and has content
      if (!fs.existsSync(chunkPath)) {
        console.error(`❌ Chunk ${i + 1} file not found: ${chunkPath}`);
        chunkResults.push({
          index: i + 1,
          transcript: `[MISSING: Chunk ${i + 1} file not found]`,
          success: false
        });
        failedChunks.push(i + 1);
        continue;
      }
      
      const chunkStats = fs.statSync(chunkPath);
      if (chunkStats.size < 1024) {
        console.error(`❌ Chunk ${i + 1} is too small (${chunkStats.size} bytes)`);
        chunkResults.push({
          index: i + 1,
          transcript: `[MISSING: Chunk ${i + 1} is too small or empty]`,
          success: false
        });
        failedChunks.push(i + 1);
        continue;
      }
      
      let transcript = null;
      let retryCount = 0;
      const maxRetries = 3;
      
      // Retry logic for failed chunks
      while (retryCount < maxRetries && !transcript) {
        try {
          const result = await transcribeWithGroq(chunkPath, detectLanguage, i + 1);
          
          if (result && !result.includes("[Error transcribing chunk")) {
            transcript = result.trim();
            break;
          } else if (retryCount < maxRetries - 1) {
            console.log(`⚠️ Chunk ${i + 1} failed, retrying in 3 seconds... (${retryCount + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        } catch (error) {
          console.error(`❌ Error processing chunk ${i + 1}:`, error.message);
          if (retryCount < maxRetries - 1) {
            console.log(`⚠️ Retrying chunk ${i + 1} in 3 seconds... (${retryCount + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        }
        retryCount++;
      }
      
      // Store result for this chunk
      if (transcript) {
        chunkResults.push({
          index: i + 1,
          transcript: transcript,
          success: true
        });
        processedChunks++;
      } else {
        chunkResults.push({
          index: i + 1,
          transcript: `[MISSING: Chunk ${i + 1} failed to transcribe after ${maxRetries} attempts]`,
          success: false
        });
        failedChunks.push(i + 1);
      }
      
      // Clean up chunk after processing
      if (fs.existsSync(chunkPath)) {
        fs.unlinkSync(chunkPath);
      }
      
      // Add delay between chunks
      if (i < chunkPaths.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    // Build full transcript
    fullTranscript = chunkResults.map(chunk => chunk.transcript).join("\n\n");

    // Cleanup original upload
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    // Display results
    const successRate = Math.round((processedChunks / chunkPaths.length) * 100);
    const warningStyle = failedChunks.length > 0 ? "color: orange;" : "color: green;";
    
    res.send(`
      <h2>✅ Transcription Complete!</h2>
      <div style="margin-bottom: 20px; padding: 10px; background: #f0f0f0; border-radius: 5px;">
        <h3>📊 Processing Summary</h3>
        <p><strong>File:</strong> ${fileName}</p>
        <p><strong>Chunks processed:</strong> ${processedChunks}/${chunkPaths.length} (<span style="${warningStyle}">${successRate}% success</span>)</p>
        ${failedChunks.length > 0 ? `<p style="color: orange;"><strong>Failed chunks:</strong> ${failedChunks.join(', ')}</p>` : ''}
      </div>
      
      <div style="margin-bottom: 20px; padding: 10px; background: #e8f4f8; border-radius: 5px;">
        <h3>📝 English Transcript</h3>
        <textarea readonly style="width: 100%; height: 400px; font-family: monospace; padding: 10px; border: 1px solid #ccc; border-radius: 5px;">${fullTranscript}</textarea>
      </div>
      
      <div style="margin-bottom: 20px;">
        <button onclick="downloadTranscript()">💾 Download Transcript</button>
        <button onclick="copyTranscript()">📋 Copy to Clipboard</button>
      </div>
      
      <a href="/">⬅ Process Another File</a>
      
      <script>
        function downloadTranscript() {
          const transcript = ${JSON.stringify(fullTranscript)};
          const blob = new Blob([transcript], { type: 'text/plain' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = '${fileName.replace(/\.[^/.]+$/, "")}_transcript.txt';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }
        
        function copyTranscript() {
          const transcript = ${JSON.stringify(fullTranscript)};
          navigator.clipboard.writeText(transcript).then(() => {
            alert('Transcript copied to clipboard!');
          });
        }
      </script>
    `);
    
  } catch (error) {
    console.error("❌ Processing error:", error);
    res.status(500).send(`
      <h2>❌ Error Processing File</h2>
      <p>Error: ${error.message}</p>
      <a href="/">⬅ Try Again</a>
    `);
  }
});

// 🔧 Split audio into clean chunks with better audio preprocessing and improved segmentation
function splitIntoChunks(inputPath, outputDir, durationSec = 60) {
  return new Promise((resolve, reject) => {
    const existingChunks = fs.readdirSync(outputDir)
      .filter(f => f.startsWith("chunk_"))
      .map(f => path.join(outputDir, f));

    existingChunks.forEach(chunk => {
      if (fs.existsSync(chunk)) fs.unlinkSync(chunk);
    });

    const outputPattern = path.join(outputDir, "chunk_%03d.wav");

    ffmpeg(inputPath)
      .audioCodec("pcm_s16le")
      .audioFrequency(16000)
      .audioChannels(1)
      .audioFilters([
        // SAFER: break into separate filters, avoid long single chain
        "volume=2.0",
        "highpass=f=80",
        "lowpass=f=8000",
        // Remove compand (causes filter errors if loudnorm is used too)
        // Optional: add back if needed but test separately
        "loudnorm"
      ])
      .outputOptions([
        "-f", "segment",
        `-segment_time`, `${durationSec}`,
        "-segment_format", "wav",
        "-reset_timestamps", "1",
        "-force_key_frames", `expr:gte(t,n_forced*${durationSec})`,
        "-avoid_negative_ts", "make_zero"
      ])
      .on("start", (cmd) => {
        console.log("🎬 FFmpeg command:", cmd);
      })
      .on("progress", (progress) => {
        if (progress.percent) {
          console.log(`⏳ Processing: ${Math.round(progress.percent)}% done`);
        }
      })
      .on("end", () => {
        console.log("✅ Audio splitting completed");

        setTimeout(() => {
          const files = fs.readdirSync(outputDir)
            .filter(f => f.startsWith("chunk_") && f.endsWith(".wav"))
            .sort()
            .map(f => path.join(outputDir, f));

          files.forEach((file, i) => {
            const sizeKB = (fs.statSync(file).size / 1024).toFixed(2);
            console.log(`📦 Chunk ${i + 1}: ${path.basename(file)} (${sizeKB} KB)`);
          });

          const validChunks = files.filter(f => fs.statSync(f).size > 1024);
          resolve(validChunks);
        }, 1000);
      })
      .on("error", (err) => {
        console.error("❌ FFmpeg error:", err.message);
        reject(err);
      })
      .output(outputPattern)
      .run();
  });
}

async function getAudioDuration(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) {
        reject(err);
      } else {
        const duration = metadata.format.duration;
        resolve(duration);
      }
    });
  });
}

// Enhanced splitting function with comprehensive coverage validation
async function splitIntoChunksEnhanced(inputPath, outputDir, durationSec = 120) {
  try {
    console.log(`📊 Processing audio file: ${path.basename(inputPath)}`);
    
    // Try to get duration, but don't fail if it doesn't work
    let totalDuration = null;
    let expectedChunks = null;
    
    try {
      totalDuration = await getAudioDuration(inputPath);
      expectedChunks = Math.ceil(totalDuration / durationSec);
      console.log(`📊 Audio duration: ${totalDuration.toFixed(2)} seconds`);
      console.log(`📊 Expected chunks: ${expectedChunks} (${durationSec}s each)`);
    } catch (durationError) {
      console.log(`⚠️ Could not get audio duration: ${durationError.message}`);
      console.log(`📊 Proceeding with chunking without duration validation`);
    }
    
    // Use the regular splitting function
    const chunks = await splitIntoChunks(inputPath, outputDir, durationSec);
    
    // Enhanced validation and gap filling for longer files
    if (totalDuration && expectedChunks) {
      console.log(`🔍 Validating chunks coverage for ${totalDuration.toFixed(2)}s audio...`);
      
      // Calculate total coverage based on chunk duration
      const actualCoverage = chunks.length * durationSec;
      const missingTime = totalDuration - actualCoverage;
      
      console.log(`📊 Chunk coverage: ${actualCoverage.toFixed(2)}s / ${totalDuration.toFixed(2)}s`);
      
      if (missingTime > 5) { // If more than 5 seconds are missing
        console.log(`⚠️ Missing ${missingTime.toFixed(2)} seconds of audio - creating additional chunks`);
        
        // Create additional chunks for missing segments
        const additionalChunks = Math.ceil(missingTime / durationSec);
        
        for (let i = 0; i < additionalChunks; i++) {
          const startTime = chunks.length * durationSec + (i * durationSec);
          const remainingTime = totalDuration - startTime;
          const chunkDuration = Math.min(durationSec, remainingTime);
          
          if (chunkDuration > 2) { // Only create chunks with at least 2 seconds
            const additionalChunkPath = path.join(outputDir, `chunk_${String(chunks.length + i).padStart(3, '0')}.wav`);
            
            console.log(`🔄 Creating additional chunk ${chunks.length + i + 1} for ${startTime.toFixed(2)}s - ${(startTime + chunkDuration).toFixed(2)}s`);
            
            try {
              await new Promise((resolve, reject) => {
                ffmpeg(inputPath)
                  .seekInput(startTime)
                  .duration(chunkDuration)
                  .audioCodec('pcm_s16le')
                  .audioFrequency(16000)
                  .audioChannels(1)
                  .audioFilters([
                    'volume=2.0',
                    'highpass=f=80',
                    'lowpass=f=8000',
                    'loudnorm'
                  ])
                  .on("end", () => {
                    console.log(`✅ Additional chunk created: ${path.basename(additionalChunkPath)}`);
                    chunks.push(additionalChunkPath);
                    resolve();
                  })
                  .on("error", (err) => {
                    console.error(`❌ Error creating additional chunk: ${err.message}`);
                    reject(err);
                  })
                  .save(additionalChunkPath);
              });
            } catch (error) {
              console.error(`❌ Failed to create additional chunk: ${error.message}`);
              break; // Stop creating additional chunks if one fails
            }
          }
        }
      }
      
      // Final validation
      const finalCoverage = chunks.length * durationSec;
      const coveragePercentage = Math.min(100, (finalCoverage / totalDuration) * 100);
      console.log(`📊 Final coverage: ${coveragePercentage.toFixed(1)}% (${chunks.length} chunks)`);
      
      if (coveragePercentage < 95) {
        console.log(`⚠️ Warning: Audio coverage is only ${coveragePercentage.toFixed(1)}%. Some content may be missing.`);
      }
    }
    
    // Sort chunks by filename to ensure correct order
    chunks.sort((a, b) => {
      const aNum = parseInt(path.basename(a).match(/chunk_(\d+)\.wav/)[1]);
      const bNum = parseInt(path.basename(b).match(/chunk_(\d+)\.wav/)[1]);
      return aNum - bNum;
    });
    
    console.log(`📊 Final result: ${chunks.length} chunks created`);
    return chunks;
    
  } catch (error) {
    console.error("❌ Enhanced splitting error:", error);
    console.log("🔄 Falling back to basic splitting...");
    // Fallback to regular splitting
    return await splitIntoChunks(inputPath, outputDir, durationSec);
  }
}

// 🔧 Transcribe a single audio chunk with optimized parameters for accuracy
async function transcribeWithGroq(audioPath, detectLanguage = true, chunkNumber = 0) {
  if (!fs.existsSync(audioPath)) {
    console.error(`❌ Chunk file not found: ${audioPath}`);
    return "[Error: Chunk file not found]";
  }

  // Check file size (Groq has a 25MB limit)
  const stats = fs.statSync(audioPath);
  const fileSizeInMB = stats.size / (1024 * 1024);
  console.log(`📊 Chunk ${chunkNumber} size: ${fileSizeInMB.toFixed(2)} MB`);
  
  if (fileSizeInMB > 25) {
    console.error(`❌ Chunk ${chunkNumber} too large: ${fileSizeInMB.toFixed(2)} MB`);
    return `[Error: Chunk ${chunkNumber} exceeds 25MB limit]`;
  }

  const form = new FormData();
  form.append("file", fs.createReadStream(audioPath), {
    filename: path.basename(audioPath),
    contentType: "audio/wav"
  });
  
  // Use whisper-large-v3 for better accuracy
  const model = "whisper-large-v3";
  form.append("model", model);
  form.append("response_format", "text");
  
  // Force English language regardless of detectLanguage setting
  form.append("language", "en");
  
  // Use lower temperature for more consistent English output
  form.append("temperature", "0.1");
  
  // Add prompt to encourage English transcription
  form.append("prompt", "Please transcribe this audio in English. If the speaker is using another language, translate it to English.");
  
  try {
    console.log(`🔄 Transcribing chunk ${chunkNumber} with model: ${model} (forced English)`);
    
    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        ...form.getHeaders(),
      },
      body: form,
    });

    if (!response.ok) {
      let errData;
      try {
        errData = await response.json();
        console.error(`❌ API Error for chunk ${chunkNumber}:`, JSON.stringify(errData, null, 2));
      } catch {
        errData = await response.text();
        console.error(`❌ API Error for chunk ${chunkNumber}:`, errData);
      }
      return `[Error transcribing chunk ${chunkNumber}: ${response.status} - ${errData.error?.message || errData}]`;
    }

    const transcript = await response.text();
    
    // Log transcript length for debugging
    console.log(`✅ Chunk ${chunkNumber} transcribed (English): ${transcript.length} chars - "${transcript.substring(0, 100)}..."`);
    
    return transcript;
    
  } catch (err) {
    console.error(`❌ Transcription error for chunk ${chunkNumber}:`, err.message);
    return `[Error transcribing chunk ${chunkNumber}: ${err.message}]`;
  }
}

// 🔧 Clean up function for graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server...');
  
  // Clean up any remaining chunks
  if (fs.existsSync(CHUNK_DIR)) {
    const chunks = fs.readdirSync(CHUNK_DIR)
      .filter(f => f.startsWith("chunk_"))
      .map(f => path.join(CHUNK_DIR, f));
    
    chunks.forEach(chunk => {
      if (fs.existsSync(chunk)) {
        fs.unlinkSync(chunk);
      }
    });
  }
  
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`📁 Upload directory: ${UPLOAD_DIR}`);
  console.log(`📁 Chunk directory: ${CHUNK_DIR}`);
  console.log(`🔧 FFmpeg path: ${ffmpegPath}`);
  console.log(`🔧 FFprobe path: ${ffprobeStatic.path || ffprobeStatic}`);
});