import React, { useState } from 'react';
import { MediaLibrary } from './MediaLibrary';
import { WebsiteImages } from './WebsiteImages';
import './MediaLibrary.css';

// One "Media Library" home for both the image pool (Library) and the fixed
// website slots (Page Images). Each tab is the existing page, rendered with its
// own <h1> suppressed so the hub owns the title.
export function MediaHub({ initialTab = 'library' }) {
  const [tab, setTab] = useState(initialTab === 'pages' ? 'pages' : 'library');
  return (
    <div className="media-hub">
      <div className="media-hub-head">
        <h1>Media Library</h1>
        <div className="media-hub-tabs">
          <button type="button" className={tab === 'library' ? 'on' : ''} onClick={() => setTab('library')}>Library</button>
          <button type="button" className={tab === 'pages' ? 'on' : ''} onClick={() => setTab('pages')}>Page Images</button>
        </div>
      </div>
      {tab === 'library' ? <MediaLibrary embedded /> : <WebsiteImages embedded />}
    </div>
  );
}
