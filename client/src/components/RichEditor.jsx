import { useEditor, EditorContent } from '@tiptap/react';
import { Node, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { ImageResize } from 'tiptap-extension-resize-image';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import './RichEditor.css';

/**
 * A playable video in the announcement body.
 *
 * There is no ready-made TipTap video node, and the YouTube extension is not
 * useful here -- these are files uploaded to our own media library, not
 * third-party embeds. Rendering a real <video> element means the poster frame
 * shows before play and the browser streams from disk rather than downloading
 * the whole file first.
 */
const Video = Node.create({
  name: 'video',
  group: 'block',
  atom: true,          // one indivisible unit; no cursor inside it
  draggable: true,
  addAttributes() {
    return { src: { default: null }, poster: { default: null } };
  },
  parseHTML() { return [{ tag: 'video[src]' }]; },
  renderHTML({ HTMLAttributes }) {
    return ['video', mergeAttributes(HTMLAttributes, {
      controls: 'controls', preload: 'metadata', playsinline: 'true',
    })];
  },
  addCommands() {
    return {
      setVideo: (attrs) => ({ commands }) => commands.insertContent({ type: 'video', attrs }),
    };
  },
});

export function RichEditor({ initialContent = '', onChange, onImageUpload, onPickVideo, placeholder }) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      ImageResize.configure({ inline: false, allowBase64: false }),
      Underline,
      // Not part of StarterKit -- without it a pasted URL is plain grey text
      // that nobody can click.
      Link.configure({ openOnClick: false, autolink: true,
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' } }),
      Video,
    ],
    content: initialContent || '',
    onUpdate: ({ editor }) => {
      onChange?.(editor.getHTML());
    },
  });

  if (!editor) return null;

  const handleImageClick = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file || !onImageUpload) return;
      try {
        const result = await onImageUpload(file);
        const url = result?.url || result;
        editor.chain().focus().setImage({ src: url, alt: '' }).run();
      } catch (err) {
        alert('Image upload failed: ' + err.message);
      }
    };
    input.click();
  };

  const handleLinkClick = () => {
    const previous = editor.getAttributes('link').href || '';
    const url = window.prompt('Link URL', previous);
    if (url === null) return;                       // cancelled
    if (url === '') return editor.chain().focus().extendMarkRange('link').unsetLink().run();
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  const handleVideoClick = async () => {
    if (!onPickVideo) return;
    const picked = await onPickVideo();            // { url, poster } from the media library
    if (picked?.url) editor.chain().focus().setVideo({ src: picked.url, poster: picked.poster || null }).run();
  };

  const btn = (action, activeCheck, title, label) => (
    <button
      type="button"
      onClick={action}
      className={activeCheck ? 'active' : ''}
      title={title}
    >
      {label}
    </button>
  );

  return (
    <div className="rich-editor">
      <div className="rich-editor-toolbar" role="toolbar" aria-label="Text formatting">
        {btn(() => editor.chain().focus().toggleBold().run(), editor.isActive('bold'), 'Bold', <strong>B</strong>)}
        {btn(() => editor.chain().focus().toggleItalic().run(), editor.isActive('italic'), 'Italic', <em>I</em>)}
        {btn(() => editor.chain().focus().toggleUnderline().run(), editor.isActive('underline'), 'Underline', <u>U</u>)}
        <span className="rich-editor-sep" aria-hidden />
        {btn(
          () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
          editor.isActive('heading', { level: 2 }),
          'Heading',
          'H2'
        )}
        <span className="rich-editor-sep" aria-hidden />
        {btn(() => editor.chain().focus().toggleBulletList().run(), editor.isActive('bulletList'), 'Bullet list', '•—')}
        {btn(() => editor.chain().focus().toggleOrderedList().run(), editor.isActive('orderedList'), 'Numbered list', '1.')}
        <span className="rich-editor-sep" aria-hidden />
        {btn(() => editor.chain().focus().toggleBlockquote().run(), editor.isActive('blockquote'), 'Quote', '"')}
        <span className="rich-editor-sep" aria-hidden />
        {btn(handleLinkClick, editor.isActive('link'), 'Add or edit link', '🔗')}
        {onImageUpload && (
          <button type="button" onClick={handleImageClick} title="Insert image">
            🖼
          </button>
        )}
        {onPickVideo && (
          <button type="button" onClick={handleVideoClick} title="Insert video from the media library">
            ▶
          </button>
        )}
      </div>
      <EditorContent
        editor={editor}
        className="rich-editor-content"
        data-placeholder={placeholder || 'Write your announcement…'}
      />
    </div>
  );
}
