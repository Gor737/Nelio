import { CourseDetails } from "./(components)/CourseDetails";

type Props = {
  params: Promise<{ id: string }>;
};

export default async function Course({ params }: Props) {
  const { id } = await params;
  return <CourseDetails id={id}/>;
}
