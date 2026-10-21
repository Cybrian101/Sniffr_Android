import { useParams, useNavigate } from 'react-router-dom';
import SharedPostViewerModal from '../components/SharedPostViewerModal';

// N1: copy-link (GalleryViewerModal, NotificationPostViewerModal,
// SharedPostViewerModal itself) all build `${origin}/post/:id` links, but
// no route ever existed for that path -- it fell through to the catch-all
// 404. This route just reuses the existing single-post viewer (already
// fetches GET /posts/:id and renders the full post, likes, comments) as a
// full page instead of a modal opened from within the app.
export default function PostPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  return <SharedPostViewerModal postId={id} onClose={() => navigate('/home', { replace: true })} />;
}
