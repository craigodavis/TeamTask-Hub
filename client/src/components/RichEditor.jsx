import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Underline from '@tiptap/extension-underline';
import './RichEditor.css';

export function RichEditor({ initialContent = '', onChange, onImageUpload, placeholder }) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Image.configure({ inline: false, allowBase64: false }),
      Underline,
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
        editor.chain().focus().setImage({ src: url }).run();
      } catch (err) {
        alert('Image upload failed: ' + err.message);
      }
    };
    input.click();
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
        {onImageUpload && (
          <button type="button" onClick={handleImageClick} title="Insert image">
            🖼
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
