'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ArrowLeft, Save, Plus, Trash2, CheckCircle2, XCircle } from 'lucide-react'
import { useToast } from '@/components/ui/use-toast'

interface DailyQuizCampaignFormProps {
    userProfile: any
    campaignId: string | null
    initialJourneyId?: string
    onBack: () => void
}

export default function DailyQuizCampaignForm({ userProfile, campaignId, initialJourneyId, onBack }: DailyQuizCampaignFormProps) {
    const [loading, setLoading] = useState(false)
    const [journeys, setJourneys] = useState<any[]>([])
    const { toast } = useToast()
    const supabase = createClient()

    const [formData, setFormData] = useState({
        name: '',
        description: '',
        journey_config_id: initialJourneyId || '',
        status: 'draft',
        start_at: '',
        end_at: '',
        max_plays_per_day: 1,
        points_per_correct_answer: 10,
        theme_config: {
            primary_color: '#8B5CF6',
            title_text: 'Daily Quiz Challenge',
            success_message: 'Great job! You scored {{score}} points!',
            show_confetti: true
        }
    })

    const [questions, setQuestions] = useState<any[]>([])
    const [plays, setPlays] = useState<any[]>([])

    useEffect(() => {
        fetchJourneys()
        if (campaignId) {
            fetchCampaign()
            fetchPlays()
        }
    }, [campaignId])

    const fetchPlays = async () => {
        if (!campaignId) return
        const { data } = await supabase
            .from('daily_quiz_plays')
            .select('*')
            .eq('campaign_id', campaignId)
            .order('played_at', { ascending: false })
        
        if (data) setPlays(data)
    }

    const fetchJourneys = async () => {
        const { data: journeysData } = await supabase
            .from('journey_configurations')
            .select('id, name, start_at, end_at')
            .eq('org_id', userProfile.organization_id)
            .eq('is_active', true)
        
        if (journeysData) {
            setJourneys(journeysData)
        }
    }

    const fetchCampaign = async () => {
        // Only called when campaignId is set (see the effect above).
        if (!campaignId) return
        setLoading(true)
        const { data: campaign, error } = await supabase
            .from('daily_quiz_campaigns')
            .select('*')
            .eq('id', campaignId)
            .single()

        if (error) {
            toast({ title: "Error", description: "Failed to load campaign", variant: "destructive" })
            onBack()
            return
        }

        setFormData({
            name: campaign.name,
            description: campaign.description || '',
            journey_config_id: campaign.journey_config_id || '',
            status: campaign.status,
            start_at: campaign.start_at ? campaign.start_at.split('T')[0] : '',
            end_at: campaign.end_at ? campaign.end_at.split('T')[0] : '',
            max_plays_per_day: campaign.max_plays_per_day || 1,
            points_per_correct_answer: campaign.points_per_correct_answer || 10,
            theme_config: campaign.theme_config || formData.theme_config
        })

        const { data: questionsData } = await supabase
            .from('daily_quiz_questions')
            .select('*')
            .eq('campaign_id', campaignId)
            .order('order_no', { ascending: true })
        
        if (questionsData) {
            // Parse options if they are strings (should be JSONB but just in case)
            const parsedQuestions = questionsData.map(q => ({
                ...q,
                options: typeof q.options === 'string' ? JSON.parse(q.options) : q.options
            }))
            setQuestions(parsedQuestions)
        }
        setLoading(false)
    }

    const handleSave = async () => {
        if (!formData.name) {
            toast({ title: "Error", description: "Campaign name is required", variant: "destructive" })
            return
        }

        if (questions.length === 0) {
            toast({ title: "Error", description: "At least one question is required", variant: "destructive" })
            return
        }

        // Validate questions
        for (let i = 0; i < questions.length; i++) {
            const q = questions[i]
            if (!q.question_text) {
                toast({ title: "Error", description: `Question ${i + 1} is missing text`, variant: "destructive" })
                return
            }
            if (q.options.some((o: string) => !o)) {
                toast({ title: "Error", description: `Question ${i + 1} has empty options`, variant: "destructive" })
                return
            }
        }

        setLoading(true)
        
        const campaignData = {
            org_id: userProfile.organization_id,
            name: formData.name,
            description: formData.description,
            journey_config_id: formData.journey_config_id || null,
            status: formData.status,
            start_at: formData.start_at ? new Date(formData.start_at).toISOString() : null,
            end_at: formData.end_at ? new Date(formData.end_at).toISOString() : null,
            max_plays_per_day: formData.max_plays_per_day,
            points_per_correct_answer: formData.points_per_correct_answer,
            theme_config: formData.theme_config,
            updated_at: new Date().toISOString(),
            created_by: userProfile.id
        }

        let currentCampaignId = campaignId

        if (campaignId) {
            const { error } = await supabase
                .from('daily_quiz_campaigns')
                .update(campaignData)
                .eq('id', campaignId)
            
            if (error) {
                toast({ title: "Error", description: error.message, variant: "destructive" })
                setLoading(false)
                return
            }
        } else {
            const { data, error } = await supabase
                .from('daily_quiz_campaigns')
                .insert(campaignData)
                .select()
                .single()
            
            if (error) {
                toast({ title: "Error", description: error.message, variant: "destructive" })
                setLoading(false)
                return
            }
            currentCampaignId = data.id
        }

        // Save questions
        // First delete existing questions (simplest way to handle reordering/updates)
        // In a real app with live data, we might want to be more careful, but for now this ensures consistency
        if (campaignId) {
            await supabase.from('daily_quiz_questions').delete().eq('campaign_id', campaignId)
        }

        const questionsToInsert = questions.map((q, index) => ({
            campaign_id: currentCampaignId,
            question_text: q.question_text,
            options: q.options,
            correct_option_index: q.correct_option_index,
            order_no: index
        }))

        const { error: questionsError } = await supabase
            .from('daily_quiz_questions')
            .insert(questionsToInsert)

        if (questionsError) {
            console.error('Questions save error:', questionsError)
            toast({ title: "Error", description: "Failed to save questions", variant: "destructive" })
        } else {
            toast({ title: "Success", description: "Campaign saved successfully" })
            onBack()
        }
        
        setLoading(false)
    }

    const addQuestion = () => {
        setQuestions([...questions, {
            question_text: '',
            options: ['', '', '', ''],
            correct_option_index: 0
        }])
    }

    const removeQuestion = (index: number) => {
        const newQuestions = [...questions]
        newQuestions.splice(index, 1)
        setQuestions(newQuestions)
    }

    const updateQuestion = (index: number, field: string, value: any) => {
        const newQuestions = [...questions]
        newQuestions[index] = { ...newQuestions[index], [field]: value }
        setQuestions(newQuestions)
    }

    const updateOption = (qIndex: number, oIndex: number, value: string) => {
        const newQuestions = [...questions]
        const newOptions = [...newQuestions[qIndex].options]
        newOptions[oIndex] = value
        newQuestions[qIndex].options = newOptions
        setQuestions(newQuestions)
    }

    return (
        <div className="space-y-6 pb-20">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                    <Button variant="ghost" size="icon" onClick={onBack}>
                        <ArrowLeft className="h-4 w-4" />
                    </Button>
                    <div>
                        <h2 className="text-2xl font-bold tracking-tight">
                            {campaignId ? 'Edit Quiz Campaign' : 'New Quiz Campaign'}
                        </h2>
                    </div>
                </div>
                <Button onClick={handleSave} disabled={loading}>
                    <Save className="mr-2 h-4 w-4" />
                    {loading ? 'Saving...' : 'Save Campaign'}
                </Button>
            </div>

            <Tabs defaultValue="basic" className="space-y-4">
                <TabsList>
                    <TabsTrigger value="basic">Basic Info</TabsTrigger>
                    <TabsTrigger value="questions">Questions</TabsTrigger>
                    <TabsTrigger value="design">Design</TabsTrigger>
                    <TabsTrigger value="plays">History</TabsTrigger>
                </TabsList>

                <TabsContent value="basic">
                    <Card>
                        <CardHeader>
                            <CardTitle>Campaign Details</CardTitle>
                            <CardDescription>Configure the basic settings for your daily quiz.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label>Campaign Name</Label>
                                    <Input 
                                        value={formData.name} 
                                        onChange={(e) => setFormData({...formData, name: e.target.value})}
                                        placeholder="e.g. Daily Trivia"
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label>Status</Label>
                                    <Select 
                                        value={formData.status} 
                                        onValueChange={(val) => setFormData({...formData, status: val})}
                                    >
                                        <SelectTrigger>
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="draft">Draft</SelectItem>
                                            <SelectItem value="active">Active</SelectItem>
                                            <SelectItem value="scheduled">Scheduled</SelectItem>
                                            <SelectItem value="ended">Ended</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>

                            <div className="space-y-2">
                                <Label>Linked Journey</Label>
                                <Select 
                                    value={formData.journey_config_id} 
                                    onValueChange={(val) => setFormData({...formData, journey_config_id: val})}
                                    disabled={journeys.length === 0 || !!initialJourneyId}
                                >
                                    <SelectTrigger>
                                        <SelectValue placeholder={journeys.length === 0 ? "No journeys found." : "Select a journey..."} />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {journeys.map(j => (
                                            <SelectItem key={j.id} value={j.id}>{j.name}</SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label>Points per Correct Answer</Label>
                                    <Input 
                                        type="number" 
                                        min="0"
                                        value={formData.points_per_correct_answer} 
                                        onChange={(e) => setFormData({...formData, points_per_correct_answer: parseInt(e.target.value) || 0})}
                                    />
                                </div>
                                <div className="space-y-2">
                                    <Label>Max Plays per Day</Label>
                                    <Input 
                                        type="number" 
                                        min="1"
                                        value={formData.max_plays_per_day} 
                                        onChange={(e) => setFormData({...formData, max_plays_per_day: parseInt(e.target.value) || 1})}
                                    />
                                </div>
                            </div>

                            <div className="space-y-2">
                                <Label>Description (Optional)</Label>
                                <Textarea 
                                    value={formData.description} 
                                    onChange={(e) => setFormData({...formData, description: e.target.value})}
                                    placeholder="Internal description..."
                                />
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="questions">
                    <Card>
                        <CardHeader className="flex flex-row items-center justify-between">
                            <div>
                                <CardTitle>Quiz Questions</CardTitle>
                                <CardDescription>
                                    Add questions for your daily quiz.
                                </CardDescription>
                            </div>
                            <Button size="sm" onClick={addQuestion}>
                                <Plus className="mr-2 h-4 w-4" /> Add Question
                            </Button>
                        </CardHeader>
                        <CardContent className="space-y-6">
                            {questions.map((q, qIndex) => (
                                <div key={qIndex} className="p-4 border rounded-lg bg-slate-50 space-y-4">
                                    <div className="flex justify-between items-start">
                                        <div className="space-y-2 flex-1 mr-4">
                                            <Label>Question {qIndex + 1}</Label>
                                            <Input 
                                                value={q.question_text} 
                                                onChange={(e) => updateQuestion(qIndex, 'question_text', e.target.value)}
                                                placeholder="Enter your question here..."
                                            />
                                        </div>
                                        <Button variant="ghost" size="icon" className="text-red-500" onClick={() => removeQuestion(qIndex)}>
                                            <Trash2 className="h-4 w-4" />
                                        </Button>
                                    </div>

                                    <div className="space-y-2">
                                        <Label>Options</Label>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                            {q.options.map((opt: string, oIndex: number) => (
                                                <div key={oIndex} className="flex items-center gap-2">
                                                    <div 
                                                        className={`w-6 h-6 rounded-full border flex items-center justify-center cursor-pointer ${q.correct_option_index === oIndex ? 'bg-green-500 border-green-500 text-white' : 'bg-white border-gray-300'}`}
                                                        onClick={() => updateQuestion(qIndex, 'correct_option_index', oIndex)}
                                                    >
                                                        {q.correct_option_index === oIndex && <CheckCircle2 className="w-4 h-4" />}
                                                    </div>
                                                    <Input 
                                                        value={opt} 
                                                        onChange={(e) => updateOption(qIndex, oIndex, e.target.value)}
                                                        placeholder={`Option ${oIndex + 1}`}
                                                        className={q.correct_option_index === oIndex ? 'border-green-500 ring-1 ring-green-500' : ''}
                                                    />
                                                </div>
                                            ))}
                                        </div>
                                        <p className="text-xs text-muted-foreground">Click the circle to mark the correct answer.</p>
                                    </div>
                                </div>
                            ))}
                            {questions.length === 0 && (
                                <div className="text-center py-8 text-muted-foreground">
                                    No questions added yet. Click "Add Question" to start.
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="design">
                    <Card>
                        <CardHeader>
                            <CardTitle>Theme & Content</CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="space-y-2">
                                <Label>Primary Color</Label>
                                <div className="flex gap-2">
                                    <Input 
                                        type="color" 
                                        value={formData.theme_config.primary_color} 
                                        onChange={(e) => setFormData({
                                            ...formData, 
                                            theme_config: { ...formData.theme_config, primary_color: e.target.value }
                                        })}
                                        className="w-12 h-10 p-1"
                                    />
                                    <Input 
                                        value={formData.theme_config.primary_color} 
                                        onChange={(e) => setFormData({
                                            ...formData, 
                                            theme_config: { ...formData.theme_config, primary_color: e.target.value }
                                        })}
                                    />
                                </div>
                            </div>

                            <div className="space-y-2">
                                <Label>Title Text</Label>
                                <Input 
                                    value={formData.theme_config.title_text} 
                                    onChange={(e) => setFormData({
                                        ...formData, 
                                        theme_config: { ...formData.theme_config, title_text: e.target.value }
                                    })}
                                />
                            </div>

                            <div className="space-y-2">
                                <Label>Success Message</Label>
                                <Input 
                                    value={formData.theme_config.success_message} 
                                    onChange={(e) => setFormData({
                                        ...formData, 
                                        theme_config: { ...formData.theme_config, success_message: e.target.value }
                                    })}
                                />
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="plays">
                    <Card>
                        <CardHeader>
                            <CardTitle>Quiz History</CardTitle>
                            <CardDescription>Recent plays and scores.</CardDescription>
                        </CardHeader>
                        <CardContent>
                            <div className="rounded-md border">
                                <table className="w-full text-sm text-left">
                                    <thead className="bg-slate-50 text-slate-500 font-medium">
                                        <tr>
                                            <th className="p-3">Date</th>
                                            <th className="p-3">Player</th>
                                            <th className="p-3">Contact</th>
                                            <th className="p-3">Score</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {plays.length === 0 ? (
                                            <tr>
                                                <td colSpan={4} className="p-8 text-center text-muted-foreground">
                                                    No plays yet.
                                                </td>
                                            </tr>
                                        ) : (
                                            plays.map((p) => (
                                                <tr key={p.id} className="border-t">
                                                    <td className="p-3">{new Date(p.played_at).toLocaleDateString()}</td>
                                                    <td className="p-3 font-medium">{p.consumer_name || 'Anonymous'}</td>
                                                    <td className="p-3">{p.consumer_phone}</td>
                                                    <td className="p-3 font-bold">{p.score}</td>
                                                </tr>
                                            ))
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>
            </Tabs>
        </div>
    )
}
